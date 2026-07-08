import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";
import { decodeLatin1, decodeUtf8, encodeLatin1, encodeUtf8, sha256Hex } from "./bytes";
import { readZipEntries, readZipEntryData, rebuildZip, ZipRewriteError, type ZipEntry } from "./zip-rewriter";

// Package-level metadata cleaning for OOXML (docx/xlsx/pptx), ODF (odt/ods/odp),
// EPUB, and RTF. Document content is never rewritten: content parts keep their
// original bytes. Known limitation (documented in the README): author names
// embedded in tracked changes or comments inside the content are content, not
// package metadata, and are left untouched.

export class OfficeCleanerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficeCleanerError";
  }
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const MINIMAL_CORE_XML =
  XML_DECLARATION +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

const MINIMAL_APP_XML =
  XML_DECLARATION +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>';

const MINIMAL_CUSTOM_XML =
  XML_DECLARATION +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>';

const MINIMAL_ODF_META_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"><office:meta/></office:document-meta>';

function parseXml(content: string, what: string) {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") errors.push(String(message));
    }
  });
  const document = parser.parseFromString(content, "text/xml");
  if (!document.documentElement || errors.length > 0) {
    throw new OfficeCleanerError(`Could not parse ${what}.`);
  }
  return document;
}

function serializeXml(document: ReturnType<DOMParser["parseFromString"]>) {
  return new XMLSerializer().serializeToString(document);
}

function entryMap(entries: ZipEntry[]) {
  return new Map(entries.map((entry) => [entry.name, entry] as const));
}

function localName(node: XmlElement) {
  return (node.localName ?? node.tagName).toLowerCase();
}

// --- OOXML -----------------------------------------------------------------

// The only docProps parts OOXML defines. Anything else under docProps/ is a
// writer-specific metadata part (e.g. Apple's docProps/meta.xml carrying a
// <generator> fingerprint) and gets dropped wholesale.
const OOXML_STANDARD_DOCPROPS = new Set(["docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"]);

function relsWithoutTargets(relsXml: string, removedNames: Set<string>) {
  const document = parseXml(relsXml, "package relationships");
  const relationships = Array.from(document.getElementsByTagName("Relationship"));
  let changed = false;
  for (const relationship of relationships) {
    const target = (relationship.getAttribute("Target") ?? "").replace(/^\//, "");
    if (removedNames.has(target)) {
      relationship.parentNode?.removeChild(relationship);
      changed = true;
    }
  }
  return changed ? serializeXml(document) : null;
}

function typesWithoutParts(typesXml: string, removedNames: Set<string>) {
  const document = parseXml(typesXml, "package content types");
  const overrides = Array.from(document.getElementsByTagName("Override"));
  let changed = false;
  for (const override of overrides) {
    const partName = (override.getAttribute("PartName") ?? "").replace(/^\//, "");
    if (removedNames.has(partName)) {
      override.parentNode?.removeChild(override);
      changed = true;
    }
  }
  return changed ? serializeXml(document) : null;
}

export function cleanOoxmlPackage(buffer: Uint8Array): Uint8Array {
  const entries = readZipEntries(buffer);
  const byName = entryMap(entries);
  if (!byName.has("[Content_Types].xml") || !byName.has("_rels/.rels")) {
    throw new OfficeCleanerError("Not a valid OOXML package.");
  }

  const replace = new Map<string, Uint8Array>();
  const remove = new Set<string>();

  if (byName.has("docProps/core.xml")) replace.set("docProps/core.xml", encodeUtf8(MINIMAL_CORE_XML));
  if (byName.has("docProps/app.xml")) replace.set("docProps/app.xml", encodeUtf8(MINIMAL_APP_XML));
  if (byName.has("docProps/custom.xml")) replace.set("docProps/custom.xml", encodeUtf8(MINIMAL_CUSTOM_XML));

  // Thumbnails and every non-standard docProps part (writer fingerprints).
  for (const entry of entries) {
    if (entry.name.startsWith("docProps/") && !OOXML_STANDARD_DOCPROPS.has(entry.name)) {
      remove.add(entry.name);
    }
  }

  if (remove.size > 0) {
    const rels = byName.get("_rels/.rels");
    if (rels) {
      const patched = relsWithoutTargets(decodeUtf8(readZipEntryData(rels)), remove);
      if (patched) replace.set("_rels/.rels", encodeUtf8(patched));
    }
    const types = byName.get("[Content_Types].xml");
    if (types) {
      const patched = typesWithoutParts(decodeUtf8(readZipEntryData(types)), remove);
      if (patched) replace.set("[Content_Types].xml", encodeUtf8(patched));
    }
  }

  return rebuildZip(entries, { replace, remove });
}

// --- ODF -------------------------------------------------------------------

function manifestWithoutEntries(manifestXml: string, removedNames: Set<string>) {
  const document = parseXml(manifestXml, "ODF manifest");
  const fileEntries = Array.from(document.getElementsByTagName("manifest:file-entry"));
  let changed = false;
  for (const fileEntry of fileEntries) {
    const fullPath = fileEntry.getAttribute("manifest:full-path") ?? "";
    if (removedNames.has(fullPath) || (fullPath.startsWith("Thumbnails/") && fullPath !== "Thumbnails/")) {
      fileEntry.parentNode?.removeChild(fileEntry);
      changed = true;
    }
  }
  return changed ? serializeXml(document) : null;
}

export function cleanOdfPackage(buffer: Uint8Array): Uint8Array {
  const entries = readZipEntries(buffer);
  const byName = entryMap(entries);
  if (!byName.has("content.xml") || !byName.has("META-INF/manifest.xml")) {
    throw new OfficeCleanerError("Not a valid ODF package.");
  }

  const replace = new Map<string, Uint8Array>();
  const remove = new Set<string>();

  if (byName.has("meta.xml")) replace.set("meta.xml", encodeUtf8(MINIMAL_ODF_META_XML));

  for (const entry of entries) {
    if (entry.name.startsWith("Thumbnails/") && entry.name !== "Thumbnails/") {
      remove.add(entry.name);
    }
  }

  if (remove.size > 0) {
    const manifest = byName.get("META-INF/manifest.xml");
    if (manifest) {
      const patched = manifestWithoutEntries(decodeUtf8(readZipEntryData(manifest)), remove);
      if (patched) replace.set("META-INF/manifest.xml", encodeUtf8(patched));
    }
  }

  return rebuildZip(entries, { replace, remove });
}

// --- EPUB ------------------------------------------------------------------

const EPUB_REMOVED_DC_ELEMENTS = new Set([
  "creator",
  "contributor",
  "publisher",
  "date",
  "description",
  "rights",
  "source",
  "coverage",
  "relation"
]);

function opfPathFromContainer(containerXml: string) {
  const document = parseXml(containerXml, "EPUB container");
  const rootfiles = Array.from(document.getElementsByTagName("rootfile"));
  const path = rootfiles[0]?.getAttribute("full-path");
  if (!path) {
    throw new OfficeCleanerError("EPUB container has no rootfile.");
  }
  return path;
}

function cleanedOpf(opfXml: string) {
  const document = parseXml(opfXml, "EPUB package document");
  // EPUB 2 may nest dc elements inside <dc-metadata>/<x-metadata> wrappers.
  const metadataElements = Array.from(document.getElementsByTagName("*")).filter((element) =>
    ["metadata", "dc-metadata", "x-metadata"].includes(localName(element as XmlElement))
  ) as XmlElement[];

  for (const metadata of metadataElements) {
    const children = Array.from(metadata.childNodes);
    for (const child of children) {
      if (child.nodeType !== 1) continue;
      const element = child as XmlElement;
      const name = localName(element);

      if (EPUB_REMOVED_DC_ELEMENTS.has(name)) {
        metadata.removeChild(element);
        continue;
      }

      if (name === "identifier") {
        // The identifier is required by the EPUB spec, but store-issued IDs can
        // link a file to a purchase. Replace it with a value derived one-way
        // from the original so it stays unique without leaking it.
        const original = element.textContent ?? "";
        const derived = sha256Hex(encodeUtf8(original)).slice(0, 32);
        while (element.firstChild) element.removeChild(element.firstChild);
        element.appendChild(document.createTextNode(`urn:freshfile:${derived}`));
        continue;
      }

      if (name === "meta") {
        const property = element.getAttribute("property")?.toLowerCase() ?? "";
        const metaName = element.getAttribute("name")?.toLowerCase() ?? "";
        if (property === "dcterms:modified") {
          // Required by EPUB 3; keep the element but neutralize the timestamp.
          while (element.firstChild) element.removeChild(element.firstChild);
          element.appendChild(document.createTextNode("1980-01-01T00:00:00Z"));
        } else if (
          // Rendering directives and accessibility statements are not privacy
          // metadata: fixed-layout (rendition:*), media overlays (media:*),
          // schema.org accessibility, and the EPUB 2 cover linkage.
          /^(rendition:|media:|schema:access|ibooks:)/.test(property) ||
          metaName === "cover"
        ) {
          continue;
        } else {
          metadata.removeChild(element);
        }
      }
    }
  }

  return serializeXml(document);
}

export function cleanEpubPackage(buffer: Uint8Array): Uint8Array {
  const entries = readZipEntries(buffer);
  const byName = entryMap(entries);
  const container = byName.get("META-INF/container.xml");
  if (!container) {
    throw new OfficeCleanerError("Not a valid EPUB package.");
  }

  const opfPath = opfPathFromContainer(decodeUtf8(readZipEntryData(container)));
  const opfEntry = byName.get(opfPath);
  if (!opfEntry) {
    throw new OfficeCleanerError("EPUB package document is missing.");
  }

  const replace = new Map<string, Uint8Array>();
  replace.set(opfPath, encodeUtf8(cleanedOpf(decodeUtf8(readZipEntryData(opfEntry)))));

  return rebuildZip(entries, { replace });
}

// --- RTF -------------------------------------------------------------------

// Control words whose entire group is metadata and is dropped wholesale.
const RTF_DROP_GROUPS = ["\\info", "\\*\\generator"];

function groupToDropAt(text: string, braceIndex: number) {
  // text[braceIndex] === "{". Return the control-word length if this group
  // opens with one of the drop words, else null.
  for (const word of RTF_DROP_GROUPS) {
    if (text.startsWith(word, braceIndex + 1)) {
      const after = text[braceIndex + 1 + word.length];
      // The word must be delimited (not a prefix of a longer control word).
      if (after === undefined || after === " " || after === "{" || after === "\\" || after === "}") {
        return word.length;
      }
    }
  }
  return null;
}

// Single linear pass (O(n)): copy the document, skipping \info and
// \*\generator groups. A previous version re-scanned from index 0 after each
// removal, which is O(n^2) and let a crafted RTF freeze the event loop.
export function cleanRtfText(text: string): string {
  // \binN embeds raw bytes that may contain unbalanced braces and would break
  // group scanning; such files are rare and rejected instead of risking
  // corruption.
  if (/\\bin\d/.test(text)) {
    throw new OfficeCleanerError("RTF files with embedded binary data are not supported.");
  }

  const out: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const char = text[i];

    if (char === "\\") {
      // Copy the escape and the escaped character together so a literal
      // \{ or \} never trips the brace scanner.
      out.push(text.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (char === "{" && groupToDropAt(text, i) !== null) {
      // Skip the whole balanced group, honoring nesting and escapes.
      let depth = 0;
      let j = i;
      for (; j < n; j += 1) {
        const c = text[j];
        if (c === "\\") {
          j += 1;
          continue;
        }
        if (c === "{") depth += 1;
        else if (c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new OfficeCleanerError("Unbalanced RTF group.");
      i = j + 1;
      continue;
    }

    out.push(char);
    i += 1;
  }

  const cleaned = out.join("");
  if (!/^\s*\{\\rtf/.test(cleaned)) {
    throw new OfficeCleanerError("RTF cleaning produced an invalid document.");
  }
  return cleaned;
}

// --- Dispatch ---------------------------------------------------------------

export const OOXML_FORMATS = new Set(["docx", "xlsx", "pptx"]);
export const ODF_FORMATS = new Set(["odt", "ods", "odp"]);

export function cleanOfficeBuffer(buffer: Uint8Array, format: string): Uint8Array {
  try {
    if (OOXML_FORMATS.has(format)) return cleanOoxmlPackage(buffer);
    if (ODF_FORMATS.has(format)) return cleanOdfPackage(buffer);
    if (format === "epub") return cleanEpubPackage(buffer);
    if (format === "rtf") return encodeLatin1(cleanRtfText(decodeLatin1(buffer)));
  } catch (error) {
    if (error instanceof ZipRewriteError || error instanceof OfficeCleanerError) {
      throw new OfficeCleanerError(error.message);
    }
    throw error;
  }

  throw new OfficeCleanerError(`No office cleaner for format ${format}.`);
}
