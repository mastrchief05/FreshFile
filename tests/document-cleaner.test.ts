import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDocumentExifToolArgs,
  buildQpdfRewriteArgs,
  cleanDocumentMetadata,
  validateCleanedDocument
} from "@/document-cleaner";

describe("document cleaner", () => {
  it("builds the document metadata removal command without shell interpolation", () => {
    expect(buildDocumentExifToolArgs("/tmp/report.pdf")).toEqual(["-all=", "-overwrite_original", "/tmp/report.pdf"]);
  });

  it("builds the qpdf rewrite command without shell interpolation", () => {
    expect(buildQpdfRewriteArgs("/tmp/in.pdf", "/tmp/out.pdf")).toEqual([
      "--warning-exit-0",
      "--deterministic-id",
      "/tmp/in.pdf",
      "/tmp/out.pdf"
    ]);
  });

  it("rewrites PDFs with qpdf after ExifTool so incremental-update remnants disappear", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-doc-"));
    const original = path.join(dir, "report.pdf");
    const cleaned = path.join(dir, "report.clean.pdf");
    await fs.writeFile(original, "%PDF-1.4 original", "utf8");

    const calls: string[] = [];
    const exifRunner = async (args: string[]) => {
      calls.push("exiftool");
      // Simulate ExifTool's incremental update leaving the old bytes behind.
      await fs.appendFile(args[args.length - 1], "\n%BeginExifToolUpdate leftover\n");
      return { stdout: "", stderr: "" };
    };
    const qpdfRunner = async (args: string[]) => {
      calls.push("qpdf");
      await fs.writeFile(args[args.length - 1], "%PDF-1.4 rebuilt\n");
      return { stdout: "", stderr: "" };
    };

    await expect(
      cleanDocumentMetadata(original, cleaned, { format: "pdf", runner: exifRunner, qpdfRunner })
    ).resolves.toMatchObject({ strategy: "pdf-rewrite" });
    expect(calls).toEqual(["exiftool", "qpdf"]);
    expect(await fs.readFile(cleaned, "utf8")).toContain("rebuilt");
  });

  it("rejects cleaned PDFs that still carry an ExifTool incremental update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-doc-"));
    const original = path.join(dir, "a.pdf");
    const cleaned = path.join(dir, "b.pdf");
    await fs.writeFile(original, "%PDF-1.4", "utf8");
    await fs.writeFile(cleaned, "%PDF-1.4\n%BeginExifToolUpdate\n", "utf8");

    await expect(validateCleanedDocument(original, cleaned, { format: "pdf" })).rejects.toThrow(
      /recoverable pre-clean metadata/
    );
  });

  it.each([
    ["txt", "plain text stays plain\n"],
    ["md", "# Heading\n\nText with a [link](https://example.com).\n"],
    ["csv", "name,price\nPixel 9,899\n"]
  ])("copies %s plain-text documents byte-for-byte (no embedded metadata container)", async (format, content) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-doc-"));
    const original = path.join(dir, `note.${format}`);
    const cleaned = path.join(dir, `note.clean.${format}`);
    await fs.writeFile(original, content, "utf8");

    await expect(cleanDocumentMetadata(original, cleaned, { format })).resolves.toMatchObject({
      strategy: "copy-no-metadata"
    });
    await expect(validateCleanedDocument(original, cleaned, { format })).resolves.toMatchObject({
      valid: true
    });
    // The cleaned file must be identical to the source (content is preserved).
    expect(await fs.readFile(cleaned)).toEqual(await fs.readFile(original));
  });
});
