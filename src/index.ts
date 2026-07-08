// freshfile — the metadata-cleaning engine behind freshfile.io.
// Node entry point: everything here may touch the filesystem and spawn
// ExifTool/FFmpeg/ImageMagick/qpdf. Browser-safe pieces live in ./browser.

export {
  configureFreshfile,
  getToolPath,
  resolveMaxUploadBytes,
  getTempFileTtlMinutes,
  type ConfigurableTool,
  type FreshfileConfig,
  type MaxUploadBytes
} from "./config";

export { cleanFile, CleaningFailedError, type CleanResult } from "./clean-file";

export {
  validateUploadedFile,
  UploadValidationError,
  SUPPORTED_FORMATS,
  acceptedExtensions,
  definitionForExtension,
  definitionsForDetected,
  extensionFromFilename,
  getFormatDefinition,
  mimeTypeForFormat,
  type FormatDefinition,
  type SupportedFormat,
  type ValidatedUpload
} from "./file-validation";

export type { CleanerStrategy, ErrorCategory, FileCategory } from "./job-types";

export {
  CATEGORY_LABELS,
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels,
  type MetadataCategory
} from "./metadata-categories";

export {
  cleanupExpiredTempFiles,
  createStorageName,
  deleteTempFile,
  deleteTempFiles,
  ensureTempRoot,
  getTempPath,
  getTempRoot,
  writeTempFile
} from "./temp-files";

export { defaultExifToolRunner, ExifToolError, type ExifToolResult, type ExifToolRunner } from "./exiftool-runner";
export {
  defaultFfmpegRunner,
  defaultFfprobeRunner,
  defaultImageMagickRunner,
  defaultQpdfRunner,
  MediaToolError,
  type ToolResult,
  type ToolRunner
} from "./media-tool-runner";

export {
  cleanImageMetadata,
  cleanTiffMetadata,
  findSensitiveMetadataKeys,
  inspectImageMetadata,
  MetadataValidationError,
  validateCleanedImage
} from "./image-cleaner";
export { cleanVideoMetadata, inspectVideoMetadata, validateCleanedVideo, VideoValidationError } from "./video-cleaner";
export { cleanAudioMetadata, validateCleanedAudio } from "./audio-cleaner";
export { cleanDocumentMetadata, inspectDocumentMetadata, PLAIN_TEXT_FORMATS, validateCleanedDocument } from "./document-cleaner";
export { cleanOfficeBuffer, ODF_FORMATS, OfficeCleanerError, OOXML_FORMATS } from "./office-cleaner";
export { cleanSvg, SvgCleanerError, validateSvgOutput } from "./svg-cleaner";
