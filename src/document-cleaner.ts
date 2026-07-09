import fs from "node:fs/promises";
import type { ExifToolRunner } from "./exiftool-runner";
import { defaultExifToolRunner, ExifToolError } from "./exiftool-runner";
import type { ToolRunner } from "./media-tool-runner";
import { defaultQpdfRunner } from "./media-tool-runner";
import { findSensitiveMetadataKeys, inspectImageMetadata, MetadataValidationError } from "./metadata-cleaner";
import { cleanOfficeBuffer, ODF_FORMATS, OOXML_FORMATS } from "./office-cleaner";
import { PackageVerificationError, verifyCleanedOfficeBytes } from "./office-verifier";

export type DocumentCleanerOptions = {
  runner?: ExifToolRunner;
  qpdfRunner?: ToolRunner;
  timeoutMs?: number;
};

// Plain-text formats carry no embedded metadata container: the bytes ARE the
// content, so cleaning is a verified byte-for-byte copy (nothing to strip).
export const PLAIN_TEXT_FORMATS = new Set(["txt", "md", "csv"]);
const plainTextFormats = PLAIN_TEXT_FORMATS;
const packageRewriteFormats = new Set([...OOXML_FORMATS, ...ODF_FORMATS, "epub", "rtf"]);

export function buildDocumentExifToolArgs(filePath: string) {
  return ["-all=", "-overwrite_original", filePath];
}

export function buildQpdfRewriteArgs(inputPath: string, outputPath: string) {
  // Rebuild the PDF from its logical object graph. ExifTool edits PDFs as an
  // incremental update, so the "deleted" Info/XMP objects remain as dead bytes
  // in the file (trivially recoverable) until this rewrite drops them.
  // --warning-exit-0: structural quirks qpdf repairs must not fail the clean;
  // --deterministic-id: derive the document /ID from content, not time/entropy.
  return ["--warning-exit-0", "--deterministic-id", inputPath, outputPath];
}

export async function inspectDocumentMetadata(filePath: string, options: DocumentCleanerOptions = {}) {
  return inspectImageMetadata(filePath, { runner: options.runner, timeoutMs: options.timeoutMs ?? 15_000 });
}

export async function cleanDocumentMetadata(
  inputPath: string,
  outputPath: string,
  options: DocumentCleanerOptions & { format?: string } = {}
) {
  if (options.format && packageRewriteFormats.has(options.format)) {
    const input = await fs.readFile(inputPath);
    const cleaned = cleanOfficeBuffer(input, options.format);
    await fs.writeFile(outputPath, cleaned, { mode: 0o600 });
    return { outputPath, strategy: "package-rewrite" as const };
  }

  await fs.copyFile(inputPath, outputPath);
  if (options.format && plainTextFormats.has(options.format)) {
    return { outputPath, strategy: "copy-no-metadata" as const };
  }
  const runner = options.runner ?? defaultExifToolRunner;
  await runner(buildDocumentExifToolArgs(outputPath), { timeoutMs: options.timeoutMs ?? 30_000 });

  if (options.format === "pdf") {
    const qpdf = options.qpdfRunner ?? defaultQpdfRunner;
    const rewrittenPath = `${outputPath}.rewrite`;
    try {
      await qpdf(buildQpdfRewriteArgs(outputPath, rewrittenPath), { timeoutMs: options.timeoutMs ?? 30_000 });
      await fs.rename(rewrittenPath, outputPath);
    } finally {
      await fs.rm(rewrittenPath, { force: true });
    }
    return { outputPath, strategy: "pdf-rewrite" as const };
  }

  return { outputPath, strategy: "exiftool-metadata" as const };
}

export async function validateCleanedDocument(
  originalPath: string,
  cleanedPath: string,
  options: DocumentCleanerOptions & { format?: string } = {}
) {
  if (options.format && plainTextFormats.has(options.format)) {
    const [original, cleaned] = await Promise.all([fs.readFile(originalPath), fs.readFile(cleanedPath)]);
    if (!original.equals(cleaned)) {
      throw new MetadataValidationError("Text document content changed during cleaning.");
    }
    return { valid: true as const, original: {}, cleaned: {} };
  }

  try {
    if (options.format === "pdf") {
      // Fail closed if the qpdf rewrite did not happen: an ExifTool incremental
      // update means the original metadata bytes are still in the file.
      const cleanedBytes = await fs.readFile(cleanedPath);
      if (cleanedBytes.includes("%BeginExifToolUpdate")) {
        throw new MetadataValidationError("PDF still contains recoverable pre-clean metadata.");
      }
    }

    if (options.format && packageRewriteFormats.has(options.format)) {
      // Second, ExifTool-independent validation layer. The ExifTool inspection
      // below is only as strong as the environment's ExifTool build (a missing
      // optional Perl module silently blinds it), so package formats are
      // additionally verified structurally from the bytes alone.
      const cleanedBytes = await fs.readFile(cleanedPath);
      try {
        verifyCleanedOfficeBytes(cleanedBytes, options.format);
      } catch (error) {
        if (error instanceof PackageVerificationError) {
          throw new MetadataValidationError(error.message);
        }
        throw error;
      }
    }

    const [original, cleaned] = await Promise.all([
      inspectDocumentMetadata(originalPath, options),
      inspectDocumentMetadata(cleanedPath, options)
    ]);
    const originalType = original["File:FileTypeExtension"] ?? original.FileTypeExtension;
    const cleanedType = cleaned["File:FileTypeExtension"] ?? cleaned.FileTypeExtension;
    if (originalType && cleanedType && String(originalType).toLowerCase() !== String(cleanedType).toLowerCase()) {
      throw new MetadataValidationError("Document format changed during cleaning.");
    }
    const remainingSensitiveKeys = findSensitiveMetadataKeys(cleaned);
    if (remainingSensitiveKeys.length > 0) {
      throw new MetadataValidationError("Privacy metadata remained after document cleaning.");
    }
    return { valid: true as const, original, cleaned };
  } catch (error) {
    if (error instanceof MetadataValidationError || error instanceof ExifToolError) {
      throw error;
    }
    throw new MetadataValidationError("Could not validate cleaned document.");
  }
}
