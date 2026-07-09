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
} from "./browser/client-image-cleaner";

export {
  cleanDocumentInBrowser,
  detectBrowserDocumentKind,
  ClientDocumentError,
  type BrowserDocumentKind,
  type ClientDocumentResult
} from "./browser/client-document-cleaner";

export {
  cleanMediaInBrowser,
  detectBrowserMediaKind,
  ClientMediaError,
  type BrowserMediaKind,
  type ClientMediaResult
} from "./browser/client-media-cleaner";

export { createZip, type ZipEntry } from "./browser/client-zip";

export { PackageVerificationError, verifyCleanedOfficeBytes } from "./formats/office-verifier";

export {
  CATEGORY_LABELS,
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels,
  type MetadataCategory
} from "./core/metadata-categories";
