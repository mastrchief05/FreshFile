import { describe, expect, it } from "vitest";
import { createZip } from "@/client-zip";
import { readZipEntries, readZipEntryData } from "@/zip-rewriter";

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

describe("client zip", () => {
  it("produces a valid ZIP that round-trips through the parser", async () => {
    const zip = createZip([
      { name: "a.txt", data: new TextEncoder().encode("hello world") },
      { name: "b.bin", data: new Uint8Array([1, 2, 3, 4, 5]) }
    ]);
    const buffer = await blobToBuffer(zip);
    const entries = readZipEntries(buffer);

    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "b.bin"]);
    expect(readZipEntryData(entries[0]).toString("utf8")).toBe("hello world");
    expect(Array.from(readZipEntryData(entries[1]))).toEqual([1, 2, 3, 4, 5]);
  });

  it("de-duplicates repeated file names", async () => {
    const zip = createZip([
      { name: "photo.jpg", data: new Uint8Array([1]) },
      { name: "photo.jpg", data: new Uint8Array([2]) },
      { name: "photo.jpg", data: new Uint8Array([3]) }
    ]);
    const names = readZipEntries(await blobToBuffer(zip)).map((entry) => entry.name);
    expect(names).toEqual(["photo.jpg", "photo (1).jpg", "photo (2).jpg"]);
  });

  it("stores UTF-8 names and uses the DOS epoch timestamp", async () => {
    const zip = createZip([{ name: "grüße.txt", data: new Uint8Array([0]) }]);
    const buffer = await blobToBuffer(zip);
    const entries = readZipEntries(buffer);
    expect(entries[0].name).toBe("grüße.txt");
    // local header mod time/date at offsets 10/12 = DOS epoch
    expect(buffer.readUInt16LE(10)).toBe(0);
    expect(buffer.readUInt16LE(12)).toBe(0x21);
  });
});
