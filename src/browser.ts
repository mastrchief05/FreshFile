// freshfile/browser — the pieces that run inside a web page. Byte-level image
// and audio cleaning plus package-level document cleaning; nothing here
// imports Node built-ins, so bundlers can ship it to the client as-is.

export {
  cleanImageInBrowser,
  cleanJpeg,
  cleanPng,
  cleanWebp,
  detectBrowserImageKind,
  ClientCleanError,
  type BrowserImageKind,
  type ClientCleanResult
} from "./client-image-cleaner";

export {
  cleanDocumentInBrowser,
  detectBrowserDocumentKind,
  ClientDocumentError,
  type BrowserDocumentKind,
  type ClientDocumentResult
} from "./client-document-cleaner";

export { createZip, type ZipEntry } from "./client-zip";

export {
  CATEGORY_LABELS,
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels,
  type MetadataCategory
} from "./metadata-categories";
