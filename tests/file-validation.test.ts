import { describe, expect, it } from "vitest";
import { validateUploadedFile } from "@/validation/file-validation";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const mp4Bytes = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32000000086d646174", "hex");
const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");
const zipBytes = Buffer.from("504b030414000000000000000000000000000000000000000000", "hex");

type ZipFixtureEntry = {
  name: string;
  data: string | Buffer;
};

function createStoredZip(entries: ZipFixtureEntry[]) {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const records: Array<{ name: Buffer; data: Buffer; localHeaderOffset: number }> = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    records.push({ name, data, localHeaderOffset: offset });
    localChunks.push(localHeader, name, data);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectoryOffset = offset;

  for (const record of records) {
    const centralHeader = Buffer.alloc(46);

    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(record.data.length, 20);
    centralHeader.writeUInt32LE(record.data.length, 24);
    centralHeader.writeUInt16LE(record.name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(record.localHeaderOffset, 42);

    centralChunks.push(centralHeader, record.name);
    offset += centralHeader.length + record.name.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

const pptxBytes = createStoredZip([
  { name: "[Content_Types].xml", data: "<Types />" },
  { name: "_rels/.rels", data: "<Relationships />" },
  { name: "ppt/presentation.xml", data: "<p:presentation />" }
]);
const epubBytes = createStoredZip([
  { name: "mimetype", data: "application/epub+zip" },
  { name: "META-INF/container.xml", data: "<container />" },
  { name: "OEBPS/package.opf", data: "<package />" }
]);
const genericZipBytes = createStoredZip([{ name: "readme.txt", data: "generic archive" }]);
const traversalDocxBytes = createStoredZip([
  { name: "[Content_Types].xml", data: "<Types />" },
  { name: "_rels/.rels", data: "<Relationships />" },
  { name: "word/document.xml", data: "<w:document />" },
  { name: "../evil.txt", data: "nope" }
]);

describe("file validation", () => {
  it("accepts a PNG with matching extension and MIME type", async () => {
    await expect(validateUploadedFile(pngBytes, "image.png", "image/png")).resolves.toMatchObject({
      category: "image",
      format: "png",
      extension: "png"
    });
  });

  it("accepts an MP4 container as video", async () => {
    await expect(validateUploadedFile(mp4Bytes, "clip.mp4", "video/mp4")).resolves.toMatchObject({
      category: "video",
      format: "mp4",
      extension: "mp4"
    });
  });

  it("accepts PDF and structurally valid Office or EPUB ZIP containers", async () => {
    await expect(validateUploadedFile(pdfBytes, "paper.pdf", "application/pdf")).resolves.toMatchObject({
      category: "document",
      format: "pdf"
    });
    await expect(validateUploadedFile(pptxBytes, "deck.pptx", "application/zip")).resolves.toMatchObject({
      category: "document",
      format: "pptx"
    });
    await expect(validateUploadedFile(epubBytes, "book.epub", "application/zip")).resolves.toMatchObject({
      category: "document",
      format: "epub"
    });
  });

  it("rejects generic or unsafe ZIP data with document extensions", async () => {
    await expect(validateUploadedFile(zipBytes, "deck.pptx", "application/zip")).rejects.toMatchObject({
      code: "suspicious_file"
    });
    await expect(validateUploadedFile(genericZipBytes, "deck.pptx", "application/zip")).rejects.toMatchObject({
      code: "suspicious_file"
    });
    await expect(validateUploadedFile(traversalDocxBytes, "paper.docx", "application/zip")).rejects.toMatchObject({
      code: "suspicious_file"
    });
  });

  it("accepts Markdown and CSV as plain-text documents", async () => {
    const md = Buffer.from("# Title\n\n- item one\n- item two\n", "utf8");
    await expect(validateUploadedFile(md, "notes.md", "text/markdown")).resolves.toMatchObject({
      category: "document",
      format: "md",
      extension: "md"
    });
    // Browsers often send text/plain for .md and Excel sends ms-excel for .csv.
    await expect(validateUploadedFile(md, "readme.markdown", "text/plain")).resolves.toMatchObject({
      format: "md"
    });
    const csv = Buffer.from("name,price\nPixel 9,899\n", "utf8");
    await expect(validateUploadedFile(csv, "sheet.csv", "application/vnd.ms-excel")).resolves.toMatchObject({
      category: "document",
      format: "csv",
      extension: "csv"
    });
  });

  it("accepts plain text containing a form-feed character", async () => {
    const txtWithFormFeed = Buffer.from("page one\n\fpage two\n", "utf8");
    await expect(validateUploadedFile(txtWithFormFeed, "doc.txt", "text/plain")).resolves.toMatchObject({
      format: "txt"
    });
  });

  it("rejects binary content mislabeled as text", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await expect(validateUploadedFile(binary, "fake.md", "text/markdown")).rejects.toMatchObject({
      code: "unsupported_format"
    });
    await expect(validateUploadedFile(binary, "fake.csv", "text/csv")).rejects.toMatchObject({
      code: "unsupported_format"
    });
  });

  it("rejects unsupported magic bytes", async () => {
    await expect(validateUploadedFile(Buffer.from("not an image"), "image.jpg", "image/jpeg")).rejects.toMatchObject({
      code: "unsupported_format"
    });
  });

  it("rejects extension and magic byte mismatches", async () => {
    await expect(validateUploadedFile(pngBytes, "image.jpg", "image/jpeg")).rejects.toMatchObject({
      code: "suspicious_file"
    });
  });

  it("rejects path traversal-like filenames", async () => {
    await expect(validateUploadedFile(pngBytes, "../image.png", "image/png")).rejects.toMatchObject({
      code: "invalid_filename"
    });
  });

  it("rejects files above an injected size limit", async () => {
    const oversizedPng = Buffer.concat([pngBytes, Buffer.alloc(1024 * 1024 + 1)]);
    await expect(
      validateUploadedFile(oversizedPng, "image.png", "image/png", { maxUploadBytes: 1024 * 1024 })
    ).rejects.toMatchObject({
      code: "file_too_large"
    });
  });

  it("resolves the size limit per category", async () => {
    const oversizedMp4 = Buffer.concat([mp4Bytes, Buffer.alloc(1024 * 1024 + 1)]);
    const perCategory = (category: string) => (category === "video" ? 1024 * 1024 : 100 * 1024 * 1024);
    await expect(
      validateUploadedFile(oversizedMp4, "clip.mp4", "video/mp4", { maxUploadBytes: perCategory })
    ).rejects.toMatchObject({
      code: "file_too_large"
    });
  });

  it("applies no size limit unless one is configured", async () => {
    const oversizedPng = Buffer.concat([pngBytes, Buffer.alloc(2 * 1024 * 1024)]);
    await expect(validateUploadedFile(oversizedPng, "image.png", "image/png")).resolves.toMatchObject({
      format: "png"
    });
  });
});
