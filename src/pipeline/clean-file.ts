import fs from "node:fs/promises";
import { cleanAudioMetadata, validateCleanedAudio } from "../cleaners/audio-cleaner";
import { cleanDocumentMetadata, PLAIN_TEXT_FORMATS, validateCleanedDocument } from "../cleaners/document-cleaner";
import {
  cleanImageMetadata,
  cleanTiffMetadata,
  findSensitiveMetadataKeys,
  inspectImageMetadata,
  MetadataValidationError,
  validateCleanedImage
} from "../cleaners/image-cleaner";
import { MediaToolError } from "../runtime/media-tool-runner";
import { OfficeCleanerError } from "../formats/office-cleaner";
import { cleanSvg, SvgCleanerError, validateSvgOutput } from "../formats/svg-cleaner";
import { cleanVideoMetadata, validateCleanedVideo, VideoValidationError } from "../cleaners/video-cleaner";
import { ExifToolError } from "../runtime/exiftool-runner";
import type { ValidatedUpload } from "../validation/file-validation";
import type { CleanerStrategy, ErrorCategory } from "../core/job-types";
import { categorizeServerKeys, type MetadataCategory } from "../core/metadata-categories";

// ExifTool cannot write BMP. BMP files rarely carry embedded metadata, so a
// byte copy is a valid clean when inspection finds nothing sensitive.
const EXIFTOOL_UNWRITABLE_IMAGE_FORMATS = new Set(["bmp"]);

// ExifTool cannot delete the IFD0 tags (Artist/Software/Copyright/…) from a
// TIFF, so `-all=` leaves them behind. TIFF is rewritten by ImageMagick instead.
const IMAGEMAGICK_STRIP_IMAGE_FORMATS = new Set(["tiff"]);

export class CleaningFailedError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string
  ) {
    super(message);
    this.name = "CleaningFailedError";
  }
}

export type CleanResult = {
  strategy: CleanerStrategy;
  outputMimeType: string;
  // Friendly categories of what was stripped (names only, never values).
  removedCategories: MetadataCategory[];
  // How many sensitive fields the original carried (0 when unknown).
  removedFieldCount: number;
};

type RemovedSummary = { categories: MetadataCategory[]; fieldCount: number };

// Inspects the ORIGINAL to report what will be removed — best-effort, never
// blocks the clean itself. Values are never read; only field-name categories
// and their count.
async function removedSummaryFor(upload: ValidatedUpload, originalPath: string): Promise<RemovedSummary> {
  try {
    if (upload.category === "svg") return { categories: ["svg"], fieldCount: 0 };
    if (PLAIN_TEXT_FORMATS.has(upload.format)) return { categories: [], fieldCount: 0 };
    const meta = await inspectImageMetadata(originalPath);
    const keys = findSensitiveMetadataKeys(meta);
    return { categories: categorizeServerKeys(keys), fieldCount: keys.length };
  } catch {
    return { categories: [], fieldCount: 0 };
  }
}

function errorCategory(error: unknown): ErrorCategory {
  if (error instanceof SvgCleanerError) return "unsafe_svg";
  if (error instanceof MetadataValidationError) return "visual_integrity";
  if (error instanceof VideoValidationError) return "visual_integrity";
  if (error instanceof ExifToolError) return "metadata_tool";
  if (error instanceof MediaToolError) return "metadata_tool";
  if (error instanceof OfficeCleanerError) return "metadata_tool";
  return "internal";
}

function publicFailureMessage(category: ErrorCategory) {
  if (category === "unsafe_svg") return "Unsupported or unsafe SVG content.";
  if (category === "visual_integrity") return "Could not safely clean without changing the file content.";
  if (category === "metadata_tool") return "Processing failed. Required metadata tools could not clean this file safely.";
  return "Processing failed.";
}

// Cleans originalPath into cleanedPath synchronously. Deleting both files is
// the caller's job (the API route responds with the bytes and removes them).
export async function cleanFile(upload: ValidatedUpload, originalPath: string, cleanedPath: string): Promise<CleanResult> {
  try {
    // Compute the removed-metadata summary from the untouched original before
    // cleaning mutates the copy.
    const removed = await removedSummaryFor(upload, originalPath);
    const removedCategories = removed.categories;
    const removedFieldCount = removed.fieldCount;

    if (upload.category === "svg") {
      const svg = await fs.readFile(originalPath, "utf8");
      const cleaned = cleanSvg(svg);
      validateSvgOutput(cleaned);
      await fs.writeFile(cleanedPath, cleaned, { mode: 0o600 });
      return { strategy: "svg-sanitize", outputMimeType: "image/svg+xml", removedCategories, removedFieldCount };
    }

    if (upload.category === "image") {
      let strategy: CleanerStrategy = "exiftool-metadata";
      if (EXIFTOOL_UNWRITABLE_IMAGE_FORMATS.has(upload.format)) {
        const originalMetadata = await inspectImageMetadata(originalPath);
        if (findSensitiveMetadataKeys(originalMetadata).length > 0) {
          throw new MetadataValidationError("Cannot remove embedded metadata from this format.");
        }
        await fs.copyFile(originalPath, cleanedPath);
        strategy = "copy-no-metadata";
      } else if (IMAGEMAGICK_STRIP_IMAGE_FORMATS.has(upload.format)) {
        await cleanTiffMetadata(originalPath, cleanedPath);
        strategy = "imagemagick-strip";
      } else {
        await cleanImageMetadata(originalPath, cleanedPath);
      }
      await validateCleanedImage(originalPath, cleanedPath);
      return { strategy, outputMimeType: upload.mimeType, removedCategories, removedFieldCount };
    }

    if (upload.category === "video") {
      const result = await cleanVideoMetadata(originalPath, cleanedPath);
      await validateCleanedVideo(originalPath, cleanedPath);
      return { strategy: result.strategy, outputMimeType: upload.mimeType, removedCategories, removedFieldCount };
    }

    if (upload.category === "audio") {
      const result = await cleanAudioMetadata(originalPath, cleanedPath);
      await validateCleanedAudio(originalPath, cleanedPath);
      return { strategy: result.strategy, outputMimeType: upload.mimeType, removedCategories, removedFieldCount };
    }

    const result = await cleanDocumentMetadata(originalPath, cleanedPath, { format: upload.format });
    await validateCleanedDocument(originalPath, cleanedPath, { format: upload.format });
    return { strategy: result.strategy, outputMimeType: upload.mimeType, removedCategories, removedFieldCount };
  } catch (error) {
    const category = errorCategory(error);
    throw new CleaningFailedError(category, publicFailureMessage(category));
  }
}
