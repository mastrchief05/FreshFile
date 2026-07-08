// Browser-side document cleaning. Runs the same isomorphic package cleaners
// the server uses (office-cleaner, svg-cleaner) directly on the user's device,
// so documents never leave the machine. Anything this module is not fully
// confident about throws ClientDocumentError — callers are expected to fall
// back to the server path, which re-validates with ExifTool.

import { bytesStartWith, decodeLatin1, decodeUtf8, encodeUtf8 } from "./bytes";
import { cleanOfficeBuffer, ODF_FORMATS, OOXML_FORMATS, OfficeCleanerError } from "./office-cleaner";
import { cleanSvg, SvgCleanerError, validateSvgOutput } from "./svg-cleaner";
import { readZipEntries, ZipRewriteError } from "./zip-rewriter";

export class ClientDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDocumentError";
  }
}

export type BrowserDocumentKind =
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "epub"
  | "svg"
  | "rtf"
  | "txt"
  | "md"
  | "csv";

export type ClientDocumentResult = {
  bytes: Uint8Array;
  kind: BrowserDocumentKind;
  strategy: "package-rewrite" | "svg-sanitize" | "copy-no-metadata";
  // Marker tokens for categorizeBrowserRemoved (names only, never values).
  removed: string[];
};

const ZIP_KINDS = new Set<BrowserDocumentKind>(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);
const TEXT_KINDS = new Set<BrowserDocumentKind>(["txt", "md", "csv"]);

const EXTENSION_TO_KIND: Record<string, BrowserDocumentKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  epub: "epub",
  svg: "svg",
  rtf: "rtf",
  txt: "txt",
  md: "md",
  markdown: "md",
  csv: "csv"
};

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function looksLikeZip(bytes: Uint8Array) {
  return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

function looksLikeSvgText(bytes: Uint8Array) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (const byte of sample) if (byte === 0) return false;
  const text = decodeUtf8(sample);
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!doctype[\s\S]*?>\s*)?<svg[\s>]/i.test(text);
}

function looksLikePlainText(bytes: Uint8Array) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (const byte of sample) {
    const isWhitespaceControl = byte >= 9 && byte <= 13;
    const isPrintable = byte >= 32 && byte !== 127;
    if (!isWhitespaceControl && !isPrintable) return false;
  }
  return true;
}

// Returns the document kind ONLY when the bytes plausibly match the claimed
// extension; everything else returns null so the caller uses the server path.
export function detectBrowserDocumentKind(bytes: Uint8Array, filename: string): BrowserDocumentKind | null {
  const kind = EXTENSION_TO_KIND[extensionOf(filename)];
  if (!kind || bytes.length === 0) return null;

  if (ZIP_KINDS.has(kind)) return looksLikeZip(bytes) ? kind : null;
  if (kind === "svg") return looksLikeSvgText(bytes) ? kind : null;
  if (kind === "rtf") return bytesStartWith(bytes, "{\\rtf") ? kind : null;
  return looksLikePlainText(bytes) ? kind : null;
}

function removedTokensForZip(bytes: Uint8Array, kind: BrowserDocumentKind): string[] {
  const tokens = new Set<string>();
  const names = readZipEntries(bytes).map((entry) => entry.name);
  if (kind === "epub") {
    tokens.add("epubMetadata");
  }
  for (const name of names) {
    if (name.startsWith("docProps/thumbnail.") || (name.startsWith("Thumbnails/") && name !== "Thumbnails/")) {
      tokens.add("thumbnail");
    } else if (name.startsWith("docProps/") || name === "meta.xml") {
      tokens.add("documentProperties");
    }
  }
  return Array.from(tokens);
}

export function cleanDocumentInBrowser(bytes: Uint8Array, filename: string): ClientDocumentResult {
  const kind = detectBrowserDocumentKind(bytes, filename);
  if (!kind) {
    throw new ClientDocumentError("Not a document this browser cleaner can handle safely.");
  }

  try {
    if (ZIP_KINDS.has(kind)) {
      const removed = removedTokensForZip(bytes, kind);
      const cleaned = cleanOfficeBuffer(bytes, kind);
      // The rebuilt package must still parse; a corrupt result must never be
      // handed to the user as "clean".
      readZipEntries(cleaned);
      return { bytes: cleaned, kind, strategy: "package-rewrite", removed };
    }

    if (kind === "svg") {
      const cleaned = cleanSvg(decodeUtf8(bytes));
      validateSvgOutput(cleaned);
      return { bytes: encodeUtf8(cleaned), kind, strategy: "svg-sanitize", removed: ["svgMetadata"] };
    }

    if (kind === "rtf") {
      const text = decodeLatin1(bytes);
      const hadMetadata = /\{\\info|\{\\\*\\generator/.test(text);
      const cleaned = cleanOfficeBuffer(bytes, "rtf");
      return {
        bytes: cleaned,
        kind,
        strategy: "package-rewrite",
        removed: hadMetadata ? ["rtfMetadata"] : []
      };
    }

    // Plain text carries no hidden metadata; the copy IS the clean.
    return { bytes, kind, strategy: "copy-no-metadata", removed: [] };
  } catch (error) {
    if (error instanceof OfficeCleanerError || error instanceof ZipRewriteError || error instanceof SvgCleanerError) {
      throw new ClientDocumentError(error.message);
    }
    throw error;
  }
}
