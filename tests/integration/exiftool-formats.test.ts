import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cleanImageMetadata,
  cleanTiffMetadata,
  inspectImageMetadata,
  validateCleanedImage
} from "@/metadata-cleaner";
import { defaultExifToolRunner } from "@/exiftool-runner";
import { defaultImageMagickRunner } from "@/media-tool-runner";

const runIntegration = process.env.RUN_EXIFTOOL_INTEGRATION === "1";

const fixtures: Record<"jpeg" | "png" | "webp", string> = {
  jpeg:
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  png:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  webp: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
};

describe.skipIf(!runIntegration)("ExifTool integration formats", () => {
  let tempDir: string;

  beforeAll(async () => {
    await defaultExifToolRunner(["-ver"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-integration-"));
  });

  async function writeFixture(name: string, format: "jpeg" | "png" | "webp") {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, Buffer.from(fixtures[format], "base64"));
    await defaultExifToolRunner([
      "-overwrite_original",
      "-Orientation=Rotate 90 CW",
      "-XMP:CreatorTool=ComfyUI",
      "-XMP:Description=private prompt",
      "-EXIF:Software=Stable Diffusion",
      filePath
    ]);
    return filePath;
  }

  it("cleans JPEG metadata while preserving orientation and dimensions", async () => {
    const original = await writeFixture("fixture.jpg", "jpeg");
    const cleaned = path.join(tempDir, "cleaned.jpg");

    await cleanImageMetadata(original, cleaned);
    await expect(validateCleanedImage(original, cleaned)).resolves.toMatchObject({ valid: true });

    const metadata = await inspectImageMetadata(cleaned);
    expect(metadata["XMP:CreatorTool"]).toBeUndefined();
    expect(metadata["EXIF:Software"]).toBeUndefined();
    expect(metadata["IFD0:Orientation"]).toBeDefined();
  });

  it("cleans PNG text metadata while preserving dimensions", async () => {
    const original = await writeFixture("fixture.png", "png");
    const cleaned = path.join(tempDir, "cleaned.png");

    await cleanImageMetadata(original, cleaned);
    await expect(validateCleanedImage(original, cleaned)).resolves.toMatchObject({ valid: true });
  });

  it("cleans WebP EXIF/XMP metadata while preserving dimensions", async () => {
    const original = await writeFixture("fixture.webp", "webp");
    const cleaned = path.join(tempDir, "cleaned.webp");

    await cleanImageMetadata(original, cleaned);
    await expect(validateCleanedImage(original, cleaned)).resolves.toMatchObject({ valid: true });
  });

  it("strips TIFF IFD0 tags via ImageMagick that ExifTool cannot remove", async () => {
    const png = path.join(tempDir, "for-tiff.png");
    await fs.writeFile(png, Buffer.from(fixtures.png, "base64"));
    const tiff = path.join(tempDir, "fixture.tiff");
    await defaultImageMagickRunner([png, tiff]);
    // IFD0 native tags ExifTool's -all= leaves behind in a TIFF.
    await defaultExifToolRunner([
      "-overwrite_original",
      "-IFD0:Artist=Mia Musterfrau",
      "-IFD0:Software=SentinelScan",
      "-IFD0:Copyright=(c) Mia",
      "-IFD0:ImageDescription=SECRET-TIFF",
      "-XMP:Description=private",
      tiff
    ]);

    const cleaned = path.join(tempDir, "cleaned.tiff");
    await cleanTiffMetadata(tiff, cleaned);
    await expect(validateCleanedImage(tiff, cleaned)).resolves.toMatchObject({ valid: true });

    const metadata = await inspectImageMetadata(cleaned);
    expect(metadata["IFD0:Artist"]).toBeUndefined();
    expect(metadata["IFD0:Software"]).toBeUndefined();
    expect(metadata["IFD0:Copyright"]).toBeUndefined();
    expect(metadata["IFD0:ImageDescription"]).toBeUndefined();
    expect(metadata["XMP:Description"]).toBeUndefined();
  });

  it("cleans PDF info metadata while preserving page structure", async () => {
    const original = path.join(tempDir, "fixture.pdf");
    const cleaned = path.join(tempDir, "cleaned.pdf");
    const minimalPdf = [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
      "xref",
      "0 4",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000052 00000 n ",
      "0000000101 00000 n ",
      "trailer<</Size 4/Root 1 0 R>>",
      "startxref",
      "164",
      "%%EOF",
      ""
    ].join("\n");
    await fs.writeFile(original, minimalPdf, "latin1");
    await defaultExifToolRunner(["-overwrite_original", "-Author=Private Person", "-Creator=ComfyUI", original]);

    const { cleanDocumentMetadata, validateCleanedDocument } = await import("@/document-cleaner");
    await expect(cleanDocumentMetadata(original, cleaned, { format: "pdf" })).resolves.toMatchObject({
      strategy: "pdf-rewrite"
    });
    await expect(validateCleanedDocument(original, cleaned, { format: "pdf" })).resolves.toMatchObject({
      valid: true
    });

    // The parsed metadata being gone is not enough: ExifTool edits PDFs as an
    // incremental update, so without the qpdf rewrite the original values
    // would still sit recoverable in the file's dead bytes.
    const cleanedBytes = await fs.readFile(cleaned);
    expect(cleanedBytes.includes("Private Person")).toBe(false);
    expect(cleanedBytes.includes("ComfyUI")).toBe(false);
    expect(cleanedBytes.includes("%BeginExifToolUpdate")).toBe(false);
    // Page structure survives the rewrite.
    const cleanedMeta = await inspectImageMetadata(cleaned);
    expect(Number(cleanedMeta["PDF:PageCount"] ?? cleanedMeta.PageCount)).toBe(1);
  });
});
