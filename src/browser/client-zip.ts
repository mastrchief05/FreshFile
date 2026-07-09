// Minimal, dependency-free ZIP writer for the browser. Uses the STORE method
// (no compression) — cleaned JPEG/PNG/WebP/PDF are already compressed, so
// storing keeps it fast and tiny. Runs entirely on the user's device.

const CRC_TABLE = (() => {
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

// De-duplicates repeated names (photo.jpg, photo (2).jpg, ...).
function uniqueNames(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = seen.get(entry.name) ?? 0;
    seen.set(entry.name, count + 1);
    if (count === 0) return entry;
    const dot = entry.name.lastIndexOf(".");
    const base = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = dot > 0 ? entry.name.slice(dot) : "";
    return { name: `${base} (${count})${ext}`, data: entry.data };
  });
}

export function createZip(rawEntries: ZipEntry[]): Blob {
  const entries = uniqueNames(rawEntries);
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const records: Array<{ nameBytes: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 name flag
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, 0, true); // mod time (DOS epoch)
    lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    localParts.push(local, entry.data);
    records.push({ nameBytes, crc, size, offset });
    offset += local.length + size;
  }

  const centralStart = offset;
  for (const record of records) {
    const central = new Uint8Array(46 + record.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, record.crc, true);
    cv.setUint32(20, record.size, true);
    cv.setUint32(24, record.size, true);
    cv.setUint16(28, record.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, record.offset, true);
    central.set(record.nameBytes, 46);
    centralParts.push(central);
    offset += central.length;
  }

  const centralSize = offset - centralStart;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, records.length, true);
  ev.setUint16(10, records.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], { type: "application/zip" });
}
