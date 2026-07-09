import { Inflate, deflateSync } from "fflate";
import { concatBytes, decodeUtf8, readU16LE, readU32LE, writeU16LE, writeU32LE } from "../core/bytes";

// Minimal ZIP reader/writer used to rewrite metadata entries inside OOXML,
// ODF, and EPUB packages without touching any other entry's bytes.
// Isomorphic on purpose: the same code cleans documents on the server and
// inside the browser, so it must not touch Buffer or node:zlib.
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
  nameBytes: Uint8Array;
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  generalPurposeFlags: number;
  compressedData: Uint8Array;
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

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const searchStart = Math.max(0, bytes.length - 65557);
  for (let index = bytes.length - 22; index >= searchStart; index -= 1) {
    if (readU32LE(bytes, index) === EOCD_SIGNATURE) {
      return index;
    }
  }
  throw new ZipRewriteError("Missing end of central directory.");
}

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readU16LE(bytes, eocdOffset + 4);
  const centralDirectoryDisk = readU16LE(bytes, eocdOffset + 6);
  const totalEntries = readU16LE(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readU32LE(bytes, eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new ZipRewriteError("Multi-disk archives are not supported.");
  }

  const entries: ZipEntry[] = [];
  const seenNames = new Set<string>();
  // Non-overlapping entry data can never exceed the archive size. Bounding the
  // cumulative compressed bytes rejects a central directory whose entries all
  // point at the same large region — a small file that would otherwise make
  // the per-entry slice() copies allocate gigabytes (memory-exhaustion DoS).
  let totalCompressed = 0;
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.length || readU32LE(bytes, offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipRewriteError("Corrupt central directory.");
    }

    const generalPurposeFlags = readU16LE(bytes, offset + 8);
    const compressionMethod = readU16LE(bytes, offset + 10);
    const crc = readU32LE(bytes, offset + 16);
    const compressedSize = readU32LE(bytes, offset + 20);
    const uncompressedSize = readU32LE(bytes, offset + 24);
    const nameLength = readU16LE(bytes, offset + 28);
    const extraLength = readU16LE(bytes, offset + 30);
    const commentLength = readU16LE(bytes, offset + 32);
    const localHeaderOffset = readU32LE(bytes, offset + 42);

    if (generalPurposeFlags & 0x0001) {
      throw new ZipRewriteError("Encrypted archives are not supported.");
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipRewriteError("ZIP64 archives are not supported.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ZipRewriteError("Unsupported compression method.");
    }

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);

    if (localHeaderOffset + 30 > bytes.length || readU32LE(bytes, localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipRewriteError("Corrupt local header.");
    }
    const localNameLength = readU16LE(bytes, localHeaderOffset + 26);
    const localExtraLength = readU16LE(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new ZipRewriteError("Entry data out of bounds.");
    }
    totalCompressed += compressedSize;
    if (totalCompressed > bytes.length) {
      throw new ZipRewriteError("ZIP entry data exceeds archive size.");
    }

    const name = decodeUtf8(nameBytes);
    // Reject malformed names up front so cleaning fails with a clean input
    // rejection instead of producing output the verifier later refuses. A
    // backslash, leading slash, ".." segment, NUL, or empty name has no place
    // in a real OOXML/ODF/EPUB package and enables path confusion downstream.
    if (
      name.length === 0 ||
      name.includes("\0") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      throw new ZipRewriteError("Suspicious ZIP entry name.");
    }
    // Duplicate names let a reader and the cleaner disagree on which entry is
    // authoritative (a metadata-smuggling channel); reject them.
    const lowerName = name.toLowerCase();
    if (seenNames.has(lowerName)) {
      throw new ZipRewriteError("Duplicate ZIP entry names.");
    }
    seenNames.add(lowerName);

    entries.push({
      nameBytes,
      name,
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      generalPurposeFlags,
      compressedData: bytes.slice(dataStart, dataEnd)
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// Hard ceiling for inflating a single entry we need to read (manifests, OPF,
// rels — all small XML). Without a cap a crafted deflate stream that declares
// a tiny size can still expand to gigabytes (decompression bomb) and OOM the
// process or the browser tab.
const MAX_INFLATED_ENTRY_BYTES = 16 * 1024 * 1024;

function inflateRawBounded(data: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflator = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ZipRewriteError("ZIP entry could not be safely decompressed.");
    }
    chunks.push(chunk);
  });
  // push() throws synchronously on corrupt streams; the ondata hook above
  // throws when the output exceeds the cap.
  inflator.push(data, true);
  return concatBytes(chunks);
}

export function readZipEntryData(entry: ZipEntry): Uint8Array {
  if (entry.compressionMethod === 0) {
    if (entry.compressedData.byteLength > MAX_INFLATED_ENTRY_BYTES) {
      throw new ZipRewriteError("ZIP entry exceeds the maximum readable size.");
    }
    return entry.compressedData;
  }
  try {
    return inflateRawBounded(entry.compressedData, MAX_INFLATED_ENTRY_BYTES);
  } catch {
    // Bomb or corrupt stream: reject rather than allocate.
    throw new ZipRewriteError("ZIP entry could not be safely decompressed.");
  }
}

export type ZipRewriteInstructions = {
  // Entry name -> new uncompressed content. The entry keeps its original
  // compression method and position.
  replace?: Map<string, Uint8Array>;
  // Entry names to drop entirely.
  remove?: Set<string>;
};

export function rebuildZip(entries: ZipEntry[], instructions: ZipRewriteInstructions = {}): Uint8Array {
  const replace = instructions.replace ?? new Map<string, Uint8Array>();
  const remove = instructions.remove ?? new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  let entryCount = 0;

  for (const entry of entries) {
    if (remove.has(entry.name)) continue;

    let { compressedData, crc32: crc, compressedSize, uncompressedSize, compressionMethod } = entry;
    const replacement = replace.get(entry.name);
    if (replacement) {
      uncompressedSize = replacement.byteLength;
      crc = crc32(replacement);
      compressedData = compressionMethod === 0 ? replacement : deflateSync(replacement, { level: 9 });
      compressedSize = compressedData.byteLength;
    }

    // Keep only the UTF-8 name flag; never write data descriptors (bit 3)
    // because sizes are known, and drop extra fields (they carry timestamps).
    const flags = entry.generalPurposeFlags & 0x0800;

    const localHeader = new Uint8Array(30);
    writeU32LE(localHeader, 0, LOCAL_HEADER_SIGNATURE);
    writeU16LE(localHeader, 4, 20);
    writeU16LE(localHeader, 6, flags);
    writeU16LE(localHeader, 8, compressionMethod);
    writeU16LE(localHeader, 10, DOS_EPOCH_TIME);
    writeU16LE(localHeader, 12, DOS_EPOCH_DATE);
    writeU32LE(localHeader, 14, crc);
    writeU32LE(localHeader, 18, compressedSize);
    writeU32LE(localHeader, 22, uncompressedSize);
    writeU16LE(localHeader, 26, entry.nameBytes.length);
    writeU16LE(localHeader, 28, 0);

    const centralHeader = new Uint8Array(46);
    writeU32LE(centralHeader, 0, CENTRAL_HEADER_SIGNATURE);
    writeU16LE(centralHeader, 4, 20);
    writeU16LE(centralHeader, 6, 20);
    writeU16LE(centralHeader, 8, flags);
    writeU16LE(centralHeader, 10, compressionMethod);
    writeU16LE(centralHeader, 12, DOS_EPOCH_TIME);
    writeU16LE(centralHeader, 14, DOS_EPOCH_DATE);
    writeU32LE(centralHeader, 16, crc);
    writeU32LE(centralHeader, 20, compressedSize);
    writeU32LE(centralHeader, 24, uncompressedSize);
    writeU16LE(centralHeader, 28, entry.nameBytes.length);
    writeU16LE(centralHeader, 30, 0);
    writeU16LE(centralHeader, 32, 0);
    writeU16LE(centralHeader, 34, 0);
    writeU16LE(centralHeader, 36, 0);
    writeU32LE(centralHeader, 38, 0);
    writeU32LE(centralHeader, 42, offset);

    localParts.push(localHeader, entry.nameBytes, compressedData);
    centralParts.push(centralHeader, entry.nameBytes);
    offset += localHeader.length + entry.nameBytes.length + compressedData.byteLength;
    entryCount += 1;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);

  const eocd = new Uint8Array(22);
  writeU32LE(eocd, 0, EOCD_SIGNATURE);
  writeU16LE(eocd, 4, 0);
  writeU16LE(eocd, 6, 0);
  writeU16LE(eocd, 8, entryCount);
  writeU16LE(eocd, 10, entryCount);
  writeU32LE(eocd, 12, centralDirectorySize);
  writeU32LE(eocd, 16, centralDirectoryOffset);
  writeU16LE(eocd, 20, 0);

  return concatBytes([...localParts, ...centralParts, eocd]);
}
