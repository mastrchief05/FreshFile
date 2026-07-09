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
} from "./core/config";

export { cleanFile, CleaningFailedError, type CleanResult } from "./pipeline/clean-file";

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
} from "./validation/file-validation";

export type { CleanerStrategy, ErrorCategory, FileCategory } from "./core/job-types";

export {
  CATEGORY_LABELS,
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels,
  type MetadataCategory
} from "./core/metadata-categories";

export {
  cleanupExpiredTempFiles,
  createStorageName,
  deleteTempFile,
  deleteTempFiles,
  ensureTempRoot,
  getTempPath,
  getTempRoot,
  writeTempFile
} from "./runtime/temp-files";

export { defaultExifToolRunner, ExifToolError, type ExifToolResult, type ExifToolRunner } from "./runtime/exiftool-runner";
export {
  defaultFfmpegRunner,
  defaultFfprobeRunner,
  defaultImageMagickRunner,
  defaultQpdfRunner,
  MediaToolError,
  type ToolResult,
  type ToolRunner
} from "./runtime/media-tool-runner";

export {
  cleanImageMetadata,
  cleanTiffMetadata,
  findSensitiveMetadataKeys,
  inspectImageMetadata,
  MetadataValidationError,
  validateCleanedImage
} from "./cleaners/image-cleaner";
export { cleanVideoMetadata, inspectVideoMetadata, validateCleanedVideo, VideoValidationError } from "./cleaners/video-cleaner";
export { cleanAudioMetadata, validateCleanedAudio } from "./cleaners/audio-cleaner";
export { cleanDocumentMetadata, inspectDocumentMetadata, PLAIN_TEXT_FORMATS, validateCleanedDocument } from "./cleaners/document-cleaner";
export { cleanOfficeBuffer, ODF_FORMATS, OfficeCleanerError, OOXML_FORMATS } from "./formats/office-cleaner";
export { PackageVerificationError, verifyCleanedOfficeBytes } from "./formats/office-verifier";
export { cleanSvg, SvgCleanerError, validateSvgOutput } from "./formats/svg-cleaner";
