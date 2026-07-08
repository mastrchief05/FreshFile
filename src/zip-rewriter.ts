import zlib from "node:zlib";

// Minimal ZIP reader/writer used to rewrite metadata entries inside OOXML,
// ODF, and EPUB packages without touching any other entry's bytes.
//
// Restrictions (fail closed): no ZIP64, no encryption, no multi-disk archives.
// Uploads with those features are rejected during validation already; this
// module re-checks and throws rather than producing a corrupt package.

export class ZipRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipRewriteError";
  }
}

export type ZipEntry = {
  nameBytes: Buffer;
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  generalPurposeFlags: number;
  compressedData: Buffer;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

// 1980-01-01 00:00:00 in DOS format: any real timestamp is privacy metadata,
// so every rebuilt entry gets the DOS epoch.
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x21;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const searchStart = Math.max(0, buffer.length - 65557);
  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) {
      return index;
    }
  }
  throw new ZipRewriteError("Missing end of central directory.");
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new ZipRewriteError("Multi-disk archives are not supported.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipRewriteError("Corrupt central directory.");
    }

    const generalPurposeFlags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    if (generalPurposeFlags & 0x0001) {
      throw new ZipRewriteError("Encrypted archives are not supported.");
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipRewriteError("ZIP64 archives are not supported.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ZipRewriteError("Unsupported compression method.");
    }

    const nameBytes = Buffer.from(buffer.subarray(offset + 46, offset + 46 + nameLength));

    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipRewriteError("Corrupt local header.");
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new ZipRewriteError("Entry data out of bounds.");
    }

    entries.push({
      nameBytes,
      name: nameBytes.toString("utf8"),
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      generalPurposeFlags,
      compressedData: Buffer.from(buffer.subarray(dataStart, dataEnd))
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// Hard ceiling for inflating a single entry we need to read (manifests, OPF,
// rels — all small XML). Without maxOutputLength a crafted deflate stream that
// declares a tiny size can still expand to gigabytes (decompression bomb) and
// OOM the instance. inflateRawSync throws RangeError when the limit is hit.
const MAX_INFLATED_ENTRY_BYTES = 16 * 1024 * 1024;

export function readZipEntryData(entry: ZipEntry): Buffer {
  if (entry.compressionMethod === 0) {
    if (entry.compressedData.byteLength > MAX_INFLATED_ENTRY_BYTES) {
      throw new ZipRewriteError("ZIP entry exceeds the maximum readable size.");
    }
    return entry.compressedData;
  }
  try {
    return zlib.inflateRawSync(entry.compressedData, { maxOutputLength: MAX_INFLATED_ENTRY_BYTES });
  } catch {
    // RangeError (bomb) or corrupt stream: reject rather than allocate.
    throw new ZipRewriteError("ZIP entry could not be safely decompressed.");
  }
}

export type ZipRewriteInstructions = {
  // Entry name -> new uncompressed content. The entry keeps its original
  // compression method and position.
  replace?: Map<string, Buffer>;
  // Entry names to drop entirely.
  remove?: Set<string>;
};

export function rebuildZip(entries: ZipEntry[], instructions: ZipRewriteInstructions = {}): Buffer {
  const replace = instructions.replace ?? new Map<string, Buffer>();
  const remove = instructions.remove ?? new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  let entryCount = 0;

  for (const entry of entries) {
    if (remove.has(entry.name)) continue;

    let { compressedData, crc32: crc, compressedSize, uncompressedSize, compressionMethod } = entry;
    const replacement = replace.get(entry.name);
    if (replacement) {
      uncompressedSize = replacement.byteLength;
      crc = crc32(replacement);
      compressedData = compressionMethod === 0 ? replacement : zlib.deflateRawSync(replacement, { level: 9 });
      compressedSize = compressedData.byteLength;
    }

    // Keep only the UTF-8 name flag; never write data descriptors (bit 3)
    // because sizes are known, and drop extra fields (they carry timestamps).
    const flags = entry.generalPurposeFlags & 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(DOS_EPOCH_TIME, 10);
    localHeader.writeUInt16LE(DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(entry.nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(DOS_EPOCH_TIME, 12);
    centralHeader.writeUInt16LE(DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(entry.nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, entry.nameBytes, compressedData);
    centralParts.push(centralHeader, entry.nameBytes);
    offset += localHeader.length + entry.nameBytes.length + compressedData.byteLength;
    entryCount += 1;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
