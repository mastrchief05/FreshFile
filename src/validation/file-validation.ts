import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { resolveMaxUploadBytes, type MaxUploadBytes } from "../core/config";
import type { FileCategory } from "../core/job-types";

export type SupportedFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "avif"
  | "heic"
  | "heif"
  | "tiff"
  | "gif"
  | "bmp"
  | "svg"
  | "mp4"
  | "m4v"
  | "mov"
  | "webm"
  | "mkv"
  | "avi"
  | "mpeg"
  | "mpg"
  | "3gp"
  | "mp3"
  | "m4a"
  | "aac"
  | "flac"
  | "wav"
  | "aiff"
  | "ogg"
  | "opus"
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "txt"
  | "md"
  | "csv"
  | "rtf"
  | "epub";

export type FormatDefinition = {
  format: SupportedFormat;
  category: FileCategory;
  extensions: string[];
  mimeTypes: string[];
  outputExtension: string;
};

type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

export const SUPPORTED_FORMATS: Record<SupportedFormat, FormatDefinition> = {
  jpeg: { format: "jpeg", category: "image", extensions: ["jpg", "jpeg"], mimeTypes: ["image/jpeg"], outputExtension: "jpg" },
  png: { format: "png", category: "image", extensions: ["png"], mimeTypes: ["image/png"], outputExtension: "png" },
  webp: { format: "webp", category: "image", extensions: ["webp"], mimeTypes: ["image/webp"], outputExtension: "webp" },
  avif: { format: "avif", category: "image", extensions: ["avif"], mimeTypes: ["image/avif"], outputExtension: "avif" },
  heic: { format: "heic", category: "image", extensions: ["heic"], mimeTypes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"], outputExtension: "heic" },
  heif: { format: "heif", category: "image", extensions: ["heif"], mimeTypes: ["image/heif", "image/heic"], outputExtension: "heif" },
  tiff: { format: "tiff", category: "image", extensions: ["tif", "tiff"], mimeTypes: ["image/tiff"], outputExtension: "tif" },
  gif: { format: "gif", category: "image", extensions: ["gif"], mimeTypes: ["image/gif"], outputExtension: "gif" },
  bmp: { format: "bmp", category: "image", extensions: ["bmp"], mimeTypes: ["image/bmp", "image/x-ms-bmp"], outputExtension: "bmp" },
  svg: { format: "svg", category: "svg", extensions: ["svg"], mimeTypes: ["image/svg+xml", "text/xml", "application/xml"], outputExtension: "svg" },
  mp4: { format: "mp4", category: "video", extensions: ["mp4"], mimeTypes: ["video/mp4", "application/mp4"], outputExtension: "mp4" },
  m4v: { format: "m4v", category: "video", extensions: ["m4v"], mimeTypes: ["video/mp4", "video/x-m4v"], outputExtension: "m4v" },
  mov: { format: "mov", category: "video", extensions: ["mov", "qt"], mimeTypes: ["video/quicktime"], outputExtension: "mov" },
  webm: { format: "webm", category: "video", extensions: ["webm"], mimeTypes: ["video/webm"], outputExtension: "webm" },
  mkv: { format: "mkv", category: "video", extensions: ["mkv"], mimeTypes: ["video/x-matroska", "video/matroska"], outputExtension: "mkv" },
  avi: { format: "avi", category: "video", extensions: ["avi"], mimeTypes: ["video/x-msvideo", "video/avi"], outputExtension: "avi" },
  mpeg: { format: "mpeg", category: "video", extensions: ["mpeg"], mimeTypes: ["video/mpeg"], outputExtension: "mpeg" },
  mpg: { format: "mpg", category: "video", extensions: ["mpg"], mimeTypes: ["video/mpeg"], outputExtension: "mpg" },
  "3gp": { format: "3gp", category: "video", extensions: ["3gp", "3gpp"], mimeTypes: ["video/3gpp", "audio/3gpp"], outputExtension: "3gp" },
  mp3: { format: "mp3", category: "audio", extensions: ["mp3"], mimeTypes: ["audio/mpeg", "audio/mp3"], outputExtension: "mp3" },
  m4a: { format: "m4a", category: "audio", extensions: ["m4a"], mimeTypes: ["audio/mp4", "audio/x-m4a", "video/mp4"], outputExtension: "m4a" },
  aac: { format: "aac", category: "audio", extensions: ["aac"], mimeTypes: ["audio/aac", "audio/aacp"], outputExtension: "aac" },
  flac: { format: "flac", category: "audio", extensions: ["flac"], mimeTypes: ["audio/flac", "audio/x-flac"], outputExtension: "flac" },
  wav: { format: "wav", category: "audio", extensions: ["wav"], mimeTypes: ["audio/wav", "audio/x-wav", "audio/vnd.wave"], outputExtension: "wav" },
  aiff: { format: "aiff", category: "audio", extensions: ["aif", "aiff", "aifc"], mimeTypes: ["audio/aiff", "audio/x-aiff"], outputExtension: "aiff" },
  ogg: { format: "ogg", category: "audio", extensions: ["ogg", "oga"], mimeTypes: ["audio/ogg", "application/ogg"], outputExtension: "ogg" },
  opus: { format: "opus", category: "audio", extensions: ["opus"], mimeTypes: ["audio/ogg", "audio/opus"], outputExtension: "opus" },
  pdf: { format: "pdf", category: "document", extensions: ["pdf"], mimeTypes: ["application/pdf"], outputExtension: "pdf" },
  docx: { format: "docx", category: "document", extensions: ["docx"], mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"], outputExtension: "docx" },
  xlsx: { format: "xlsx", category: "document", extensions: ["xlsx"], mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"], outputExtension: "xlsx" },
  pptx: { format: "pptx", category: "document", extensions: ["pptx"], mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip"], outputExtension: "pptx" },
  odt: { format: "odt", category: "document", extensions: ["odt"], mimeTypes: ["application/vnd.oasis.opendocument.text", "application/zip"], outputExtension: "odt" },
  ods: { format: "ods", category: "document", extensions: ["ods"], mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet", "application/zip"], outputExtension: "ods" },
  odp: { format: "odp", category: "document", extensions: ["odp"], mimeTypes: ["application/vnd.oasis.opendocument.presentation", "application/zip"], outputExtension: "odp" },
  txt: { format: "txt", category: "document", extensions: ["txt"], mimeTypes: ["text/plain"], outputExtension: "txt" },
  md: { format: "md", category: "document", extensions: ["md", "markdown"], mimeTypes: ["text/markdown", "text/x-markdown", "text/plain"], outputExtension: "md" },
  csv: { format: "csv", category: "document", extensions: ["csv"], mimeTypes: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"], outputExtension: "csv" },
  rtf: { format: "rtf", category: "document", extensions: ["rtf"], mimeTypes: ["application/rtf", "text/rtf"], outputExtension: "rtf" },
  epub: { format: "epub", category: "document", extensions: ["epub"], mimeTypes: ["application/epub+zip", "application/zip"], outputExtension: "epub" }
};

const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes("\0"), "Invalid filename.")
  .refine((name) => !/[\\/]/.test(name), "Invalid filename.")
  .refine((name) => !name.split(".").includes("..") && !name.includes(".."), "Invalid filename.");

export class UploadValidationError extends Error {
  constructor(
    public readonly code: "unsupported_format" | "file_too_large" | "suspicious_file" | "invalid_filename",
    message: string
  ) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export type ValidatedUpload = {
  category: FileCategory;
  format: SupportedFormat;
  extension: string;
  outputExtension: string;
  mimeType: string;
  size: number;
};

export function extensionFromFilename(filename: string) {
  return path.extname(filename).replace(/^\./, "").toLowerCase();
}

export function getFormatDefinition(format: string) {
  return SUPPORTED_FORMATS[format as SupportedFormat];
}

export function mimeTypeForFormat(format: string) {
  return getFormatDefinition(format)?.mimeTypes[0] ?? "application/octet-stream";
}

export function acceptedExtensions() {
  return Object.values(SUPPORTED_FORMATS)
    .flatMap((definition) => definition.extensions)
    .map((extension) => `.${extension}`)
    .join(",");
}

export function definitionForExtension(extension: string) {
  return Object.values(SUPPORTED_FORMATS).find((definition) => definition.extensions.includes(extension));
}

export function definitionsForDetected(extension: string | undefined, mimeType: string | undefined) {
  return Object.values(SUPPORTED_FORMATS).filter((definition) => {
    if (extension && definition.extensions.includes(extension.toLowerCase())) return true;
    if (mimeType && definition.mimeTypes.includes(mimeType.toLowerCase())) return true;
    return false;
  });
}

function looksLikeSvg(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  const text = sample.toString("utf8");
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!doctype[\s\S]*?>\s*)?<svg[\s>]/i.test(text);
}

function looksLikeRtf(buffer: Buffer) {
  return buffer.subarray(0, 8).toString("ascii").startsWith("{\\rtf");
}

function looksLikePdf(buffer: Buffer) {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function looksLikeZip(buffer: Buffer) {
  const signature = buffer.subarray(0, 4).toString("hex");
  return signature === "504b0304" || signature === "504b0506" || signature === "504b0708";
}

function looksLikePlainText(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  // Allow the printable range plus the whitespace control characters that occur
  // in legitimate text: tab (9), LF (10), VT (11), form-feed (12), CR (13).
  // Form-feed in particular is common in RFCs and other paginated text exports.
  return sample.every(
    (byte) => (byte >= 9 && byte <= 13) || (byte >= 32 && byte !== 127)
  );
}

function matchesTextualFallback(definition: FormatDefinition, buffer: Buffer) {
  if (definition.format === "svg") return looksLikeSvg(buffer);
  if (definition.format === "rtf") return looksLikeRtf(buffer);
  if (definition.format === "txt" || definition.format === "md" || definition.format === "csv") {
    return looksLikePlainText(buffer);
  }
  if (definition.format === "pdf") return looksLikePdf(buffer);
  return false;
}

const ZIP_BASED_DOCUMENT_FORMATS = new Set<SupportedFormat>([
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub"
]);
const MAX_ZIP_ENTRY_COUNT = 2000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

function isZipBasedDocumentFormat(format: SupportedFormat) {
  return ZIP_BASED_DOCUMENT_FORMATS.has(format);
}

function isUnsafeZipPath(name: string) {
  if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(name)) return true;

  const normalized = name.replaceAll("\\", "/");
  return normalized.split("/").some((part) => part === "..");
}

function parseZipEntries(buffer: Buffer): ZipEntry[] | null {
  if (!looksLikeZip(buffer)) return null;

  const eocdSignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localHeaderSignature = 0x04034b50;
  const searchStart = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;

  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }

  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) return null;

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) return null;
  if (totalEntries === 0 || totalEntries > MAX_ZIP_ENTRY_COUNT) return null;
  if (
    centralDirectoryOffset > buffer.length ||
    centralDirectorySize > buffer.length ||
    centralDirectoryOffset + centralDirectorySize > buffer.length
  ) {
    return null;
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  let totalUncompressedSize = 0;
  let totalCompressedSize = 0;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralDirectorySignature) {
      return null;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;

    if (nameEnd > buffer.length || nextOffset > buffer.length) return null;

    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    if (isUnsafeZipPath(name)) return null;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      return null;
    }
    if (compressedSize === 0 && uncompressedSize > 0) return null;
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== localHeaderSignature) {
      return null;
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > buffer.length || dataEnd > buffer.length) return null;

    totalCompressedSize += compressedSize;
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES) return null;

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    offset = nextOffset;
  }

  if (offset !== centralDirectoryOffset + centralDirectorySize) return null;
  if (totalCompressedSize > 0 && totalUncompressedSize / totalCompressedSize > MAX_ZIP_COMPRESSION_RATIO) {
    return null;
  }

  return entries;
}

function zipEntryNames(entries: ZipEntry[]) {
  return new Set(entries.map((entry) => entry.name.replaceAll("\\", "/")));
}

function hasZipEntryPrefix(names: Set<string>, prefix: string) {
  return Array.from(names).some((name) => name.startsWith(prefix));
}

function readStoredZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number) {
  const localHeaderSignature = 0x04034b50;
  const offset = entry.localHeaderOffset;

  if (entry.compressionMethod !== 0 || entry.compressedSize > maxBytes || entry.uncompressedSize > maxBytes) {
    return null;
  }

  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== localHeaderSignature) return null;

  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataStart > buffer.length || dataEnd > buffer.length) return null;
  return buffer.subarray(dataStart, dataEnd).toString("utf8");
}

function matchesZipContainer(definition: FormatDefinition, buffer: Buffer) {
  if (!isZipBasedDocumentFormat(definition.format)) return false;

  const entries = parseZipEntries(buffer);
  if (!entries) return false;

  const names = zipEntryNames(entries);
  const hasEntry = (name: string) => names.has(name);

  if (definition.format === "docx") {
    return hasEntry("[Content_Types].xml") && hasEntry("_rels/.rels") && hasEntry("word/document.xml");
  }

  if (definition.format === "xlsx") {
    return hasEntry("[Content_Types].xml") && hasEntry("_rels/.rels") && hasEntry("xl/workbook.xml");
  }

  if (definition.format === "pptx") {
    return hasEntry("[Content_Types].xml") && hasEntry("_rels/.rels") && hasEntry("ppt/presentation.xml");
  }

  if (definition.format === "odt" || definition.format === "ods" || definition.format === "odp") {
    const expectedMimeType = {
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odp: "application/vnd.oasis.opendocument.presentation"
    }[definition.format];
    const mimetypeEntry = entries.find((entry) => entry.name === "mimetype");
    const mimetype = mimetypeEntry ? readStoredZipEntry(buffer, mimetypeEntry, 256) : null;

    return mimetype === expectedMimeType && hasEntry("META-INF/manifest.xml") && hasEntry("content.xml");
  }

  if (definition.format === "epub") {
    const mimetypeEntry = entries.find((entry) => entry.name === "mimetype");
    const mimetype = mimetypeEntry ? readStoredZipEntry(buffer, mimetypeEntry, 256) : null;

    return (
      mimetype === "application/epub+zip" &&
      hasEntry("META-INF/container.xml") &&
      (hasZipEntryPrefix(names, "OEBPS/") || hasZipEntryPrefix(names, "OPS/") || hasZipEntryPrefix(names, "EPUB/"))
    );
  }

  return false;
}

function matchesContainerFallback(definition: FormatDefinition, buffer: Buffer, detectedExt?: string, detectedMime?: string) {
  if (isZipBasedDocumentFormat(definition.format)) {
    return (
      (looksLikeZip(buffer) || detectedExt === "zip" || detectedMime === "application/zip") &&
      matchesZipContainer(definition, buffer)
    );
  }

  return false;
}

function selectDefinition(buffer: Buffer, filenameExtension: string, detectedExt?: string, detectedMime?: string) {
  const extensionDefinition = definitionForExtension(filenameExtension);
  if (!extensionDefinition) return null;

  if (isZipBasedDocumentFormat(extensionDefinition.format)) {
    return matchesContainerFallback(extensionDefinition, buffer, detectedExt, detectedMime) ? extensionDefinition : null;
  }

  const detectedDefinitions = definitionsForDetected(detectedExt, detectedMime);
  if (detectedDefinitions.some((definition) => definition.format === extensionDefinition.format)) {
    return extensionDefinition;
  }

  if (extensionDefinition.mimeTypes.includes(detectedMime?.toLowerCase() ?? "")) {
    return extensionDefinition;
  }

  // Only fall back to content sniffing when file-type recognized NO supported
  // format. Otherwise a binary that file-type positively identifies (e.g. a
  // PDF or RTF) but that is named .txt/.md/.csv would pass the textual
  // fallback — which merely checks the head for the absence of NUL bytes — and
  // be "cleaned" as plain text: a byte-for-byte copy that silently keeps all
  // its embedded metadata. A detected mismatch must fall through to null so
  // validateUploadedFile raises suspicious_file instead.
  if (detectedDefinitions.length === 0) {
    if (matchesTextualFallback(extensionDefinition, buffer)) {
      return extensionDefinition;
    }
    if (matchesContainerFallback(extensionDefinition, buffer, detectedExt, detectedMime)) {
      return extensionDefinition;
    }
  }

  return null;
}

export async function validateUploadedFile(
  buffer: Buffer,
  filename: string,
  browserMimeType?: string,
  options: { size?: number; maxUploadBytes?: MaxUploadBytes } = {}
): Promise<ValidatedUpload> {
  const filenameResult = fileNameSchema.safeParse(filename);
  if (!filenameResult.success) {
    throw new UploadValidationError("invalid_filename", "Rejected suspicious filename.");
  }

  const extension = extensionFromFilename(filename);
  const detected = await fileTypeFromBuffer(buffer);
  const definition = selectDefinition(buffer, extension, detected?.ext, detected?.mime);

  if (!definition) {
    const extensionDefinition = definitionForExtension(extension);
    const detectedDefinitions = definitionsForDetected(detected?.ext, detected?.mime);
    if (
      extensionDefinition &&
      (detectedDefinitions.length > 0 ||
        (isZipBasedDocumentFormat(extensionDefinition.format) && looksLikeZip(buffer)))
    ) {
      throw new UploadValidationError("suspicious_file", "File extension does not match the detected file format.");
    }

    throw new UploadValidationError(
      "unsupported_format",
      "Unsupported format. Use common images, videos, audio files, PDFs, or office documents."
    );
  }

  const uploadSize = options.size ?? buffer.byteLength;
  const maxUploadBytes = resolveMaxUploadBytes(definition.category, options.maxUploadBytes);
  if (maxUploadBytes !== null && uploadSize > maxUploadBytes) {
    throw new UploadValidationError(
      "file_too_large",
      `File too large. Maximum ${definition.category} upload size is ${Math.round(maxUploadBytes / 1024 / 1024)} MB.`
    );
  }

  if (!definition.extensions.includes(extension)) {
    throw new UploadValidationError("suspicious_file", "File extension does not match the detected file format.");
  }

  const providedMime = browserMimeType?.toLowerCase();
  if (
    providedMime &&
    providedMime !== "application/octet-stream" &&
    !definition.mimeTypes.includes(providedMime)
  ) {
    throw new UploadValidationError("suspicious_file", "MIME type does not match the detected file format.");
  }

  return {
    category: definition.category,
    format: definition.format,
    extension,
    outputExtension: extension,
    mimeType: definition.mimeTypes[0],
    size: uploadSize
  };
}

export const validateUploadedImage = validateUploadedFile;
