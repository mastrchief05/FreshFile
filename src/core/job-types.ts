// Shared domain types. (Historic filename: the job queue was replaced by
// synchronous per-request cleaning; these types survived the migration.)

export type FileCategory = "image" | "svg" | "video" | "audio" | "document";

export type CleanerStrategy =
  | "svg-sanitize"
  | "exiftool-metadata"
  | "imagemagick-strip"
  | "ffmpeg-stream-copy"
  | "copy-no-metadata"
  | "package-rewrite"
  | "pdf-rewrite"
  | "browser-strip";

export type ErrorCategory =
  | "unsupported_format"
  | "file_too_large"
  | "unsafe_svg"
  | "metadata_tool"
  | "visual_integrity"
  | "rate_limited"
  | "storage"
  | "configuration"
  | "internal";
