// freshfile/browser — the pieces that run inside a web page. Pure byte-level
// JPEG/PNG/WebP cleaning with zero dependencies; nothing here imports Node
// built-ins, so bundlers can ship it to the client as-is.

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

export { createZip, type ZipEntry } from "./client-zip";

export {
  CATEGORY_LABELS,
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels,
  type MetadataCategory
} from "./metadata-categories";
