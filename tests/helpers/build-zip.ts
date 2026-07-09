import zlib from "node:zlib";
import { crc32 } from "@/zip-rewriter";

export type FixtureEntry = {
  name: string;
  data: string | Buffer;
  stored?: boolean;
  // Raw extra-field bytes written into the local header — used by verifier
  // tests to prove that tampered/unnormalized packages are rejected.
  localExtraField?: Buffer;
};

export type BuildZipOptions = {
  // Write DOS-epoch timestamps (what the cleaner emits) instead of the default
  // non-epoch marker, so a structural fixture reaches the verifier's policy
  // checks that would otherwise trip on the timestamp check first.
  epoch?: boolean;
};

// Builds a real ZIP (deflate by default, stored on demand) without external
// deps. By default it writes a non-epoch timestamp so cleaner output (which
// resets timestamps to the DOS epoch) is distinguishable from the input.
export function buildZip(entries: FixtureEntry[], options: BuildZipOptions = {}) {
  const time = options.epoch ? 0 : 0x7000;
  const date = options.epoch ? 0x21 : 0x5a21;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.stored ? 0 : 8;
    const compressed = entry.stored ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);
    const extra = entry.localExtraField ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, extra, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + extra.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
