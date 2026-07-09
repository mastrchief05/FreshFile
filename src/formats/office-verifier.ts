import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { decodeLatin1, decodeUtf8, readU16LE, readU32LE } from "../core/bytes";
import { ODF_FORMATS, OOXML_FORMATS, resolveOpcTarget } from "./office-cleaner";
import { readZipEntryData, type ZipEntry } from "./zip-rewriter";

// Second, ExifTool-independent validation layer for cleaned document packages.
//
// The first validation layer asks ExifTool "do you still see metadata?" — but
// ExifTool degrades gracefully: in an environment where it cannot look inside
// a format (the 2026-07-08 incident: no Archive::Zip on Cloud Run), it reports
// nothing and the validation is silently blind. This module is the fail-closed
// counterpart: it re-derives, from the bytes alone, that the cleaned file has
// exactly the structure the cleaner guarantees — and throws on any deviation.
//
// It deliberately does NOT share the cleaner's parsing pipeline: the ZIP
// walker below re-implements central-directory parsing so a bug in
// zip-rewriter cannot hide itself, and the per-format policies (which parts
// may exist, which elements must be empty) are declared here a second time so
// a weakened cleaner diverges from the verifier instead of both drifting
// together. Isomorphic like the cleaner: runs on the server and in the
// browser.

export class PackageVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageVerificationError";
  }
}

function fail(message: string): never {
  throw new PackageVerificationError(message);
}

// --- ZIP structure -----------------------------------------------------------

// rebuildZip output is fully deterministic: local headers back to back from
// offset 0, then the central directory, then a comment-free EOCD as the last
// 22 bytes. Every header field is fixed (version 20, flags at most the UTF-8
// bit, method 0 or 8, DOS-epoch timestamps, no extra fields, no comments, no
// attributes). Verifying those constants plus exact byte accounting proves no
// foreign bytes hide anywhere in the file — before, between, or after entries.

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x21;

type VerifiedEntry = {
  name: string;
  entry: ZipEntry;
};

function hasDotDotSegment(name: string) {
  return name.split("/").includes("..");
}

function verifyZipStructure(bytes: Uint8Array): Map<string, VerifiedEntry> {
  if (bytes.length < 22) fail("Too small to be a cleaned package.");

  const eocdOffset = bytes.length - 22;
  if (readU32LE(bytes, eocdOffset) !== EOCD_SIGNATURE) {
    fail("Cleaned package must end with a comment-free end-of-central-directory record.");
  }
  if (readU16LE(bytes, eocdOffset + 4) !== 0 || readU16LE(bytes, eocdOffset + 6) !== 0) {
    fail("Multi-disk archives are never produced by the cleaner.");
  }
  const entriesOnDisk = readU16LE(bytes, eocdOffset + 8);
  const totalEntries = readU16LE(bytes, eocdOffset + 10);
  const centralSize = readU32LE(bytes, eocdOffset + 12);
  const centralOffset = readU32LE(bytes, eocdOffset + 16);
  if (readU16LE(bytes, eocdOffset + 20) !== 0) fail("ZIP comments are never produced by the cleaner.");
  if (entriesOnDisk !== totalEntries) fail("Inconsistent entry counts.");
  if (centralOffset + centralSize !== eocdOffset) {
    fail("Foreign bytes between the central directory and the end record.");
  }

  const entries = new Map<string, VerifiedEntry>();
  let expectedLocalOffset = 0;
  let centralCursor = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > eocdOffset || readU32LE(bytes, centralCursor) !== CENTRAL_HEADER_SIGNATURE) {
      fail("Corrupt central directory.");
    }
    if (readU16LE(bytes, centralCursor + 4) !== 20 || readU16LE(bytes, centralCursor + 6) !== 20) {
      fail("Unexpected ZIP version fields.");
    }
    const flags = readU16LE(bytes, centralCursor + 8);
    if ((flags & ~0x0800) !== 0) fail("Unexpected ZIP flags.");
    const method = readU16LE(bytes, centralCursor + 10);
    if (method !== 0 && method !== 8) fail("Unexpected compression method.");
    if (readU16LE(bytes, centralCursor + 12) !== DOS_EPOCH_TIME || readU16LE(bytes, centralCursor + 14) !== DOS_EPOCH_DATE) {
      fail("Entry timestamp was not reset to the DOS epoch.");
    }
    const crc = readU32LE(bytes, centralCursor + 16);
    const compressedSize = readU32LE(bytes, centralCursor + 20);
    const uncompressedSize = readU32LE(bytes, centralCursor + 24);
    const nameLength = readU16LE(bytes, centralCursor + 28);
    if (readU16LE(bytes, centralCursor + 30) !== 0) fail("Extra fields are never produced by the cleaner.");
    if (readU16LE(bytes, centralCursor + 32) !== 0) fail("Entry comments are never produced by the cleaner.");
    if (readU16LE(bytes, centralCursor + 34) !== 0) fail("Unexpected disk-start field.");
    if (readU16LE(bytes, centralCursor + 36) !== 0 || readU32LE(bytes, centralCursor + 38) !== 0) {
      fail("File attributes are never produced by the cleaner.");
    }
    const localHeaderOffset = readU32LE(bytes, centralCursor + 42);
    if (localHeaderOffset !== expectedLocalOffset) {
      fail("Foreign bytes between ZIP entries.");
    }
    if (centralCursor + 46 + nameLength > eocdOffset) fail("Corrupt central directory.");
    const nameBytes = bytes.slice(centralCursor + 46, centralCursor + 46 + nameLength);
    const name = decodeUtf8(nameBytes);

    if (localHeaderOffset + 30 + nameLength > centralOffset) fail("Corrupt local header.");
    if (readU32LE(bytes, localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) fail("Corrupt local header.");
    if (readU16LE(bytes, localHeaderOffset + 4) !== 20) fail("Unexpected ZIP version fields.");
    if (readU16LE(bytes, localHeaderOffset + 6) !== flags) fail("Local and central flags disagree.");
    if (readU16LE(bytes, localHeaderOffset + 8) !== method) fail("Local and central methods disagree.");
    if (
      readU16LE(bytes, localHeaderOffset + 10) !== DOS_EPOCH_TIME ||
      readU16LE(bytes, localHeaderOffset + 12) !== DOS_EPOCH_DATE
    ) {
      fail("Entry timestamp was not reset to the DOS epoch.");
    }
    if (
      readU32LE(bytes, localHeaderOffset + 14) !== crc ||
      readU32LE(bytes, localHeaderOffset + 18) !== compressedSize ||
      readU32LE(bytes, localHeaderOffset + 22) !== uncompressedSize
    ) {
      fail("Local and central records disagree.");
    }
    if (readU16LE(bytes, localHeaderOffset + 26) !== nameLength) fail("Local and central names disagree.");
    if (readU16LE(bytes, localHeaderOffset + 28) !== 0) fail("Extra fields are never produced by the cleaner.");
    const localNameBytes = bytes.slice(localHeaderOffset + 30, localHeaderOffset + 30 + nameLength);
    for (let i = 0; i < nameLength; i += 1) {
      if (localNameBytes[i] !== nameBytes[i]) fail("Local and central names disagree.");
    }

    const dataStart = localHeaderOffset + 30 + nameLength;
    if (dataStart + compressedSize > centralOffset) fail("Entry data out of bounds.");

    if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || hasDotDotSegment(name)) {
      fail("Suspicious entry name.");
    }
    if (entries.has(name)) fail("Duplicate entry names.");

    entries.set(name, {
      name,
      entry: {
        nameBytes,
        name,
        compressionMethod: method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        generalPurposeFlags: flags,
        compressedData: bytes.slice(dataStart, dataStart + compressedSize)
      }
    });

    expectedLocalOffset = dataStart + compressedSize;
    centralCursor += 46 + nameLength;
  }

  if (expectedLocalOffset !== centralOffset) fail("Foreign bytes before the central directory.");
  if (centralCursor !== centralOffset + centralSize) fail("Central directory size mismatch.");

  return entries;
}

// --- XML helpers -------------------------------------------------------------

function parseXml(content: string, what: string) {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") errors.push(String(message));
    }
  });
  const document = parser.parseFromString(content, "text/xml");
  if (!document.documentElement || errors.length > 0) {
    fail(`Could not parse ${what}.`);
  }
  return document;
}

function elementChildren(element: XmlElement): XmlElement[] {
  return Array.from(element.childNodes).filter((node) => node.nodeType === 1) as XmlElement[];
}

// Fail-closed content check. Element children are policed separately by the
// callers (via elementChildren), so they are ignored here; every OTHER node is
// forbidden unless it is whitespace-only text. This deliberately rejects
// comments (nodeType 8), processing instructions (7) and CDATA (4): a property
// part whose root holds only "<!-- Author: Jane Doe -->" or "<?leak ...?>"
// would otherwise be certified empty while carrying recoverable metadata.
function hasForbiddenNonElementContent(element: XmlElement) {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 1) continue;
    if (node.nodeType === 3 && !/\S/.test(node.nodeValue ?? "")) continue;
    return true;
  }
  return false;
}

function localName(element: XmlElement) {
  return (element.localName ?? element.tagName).toLowerCase();
}

function entryXml(entries: Map<string, VerifiedEntry>, name: string, what: string) {
  const found = entries.get(name);
  if (!found) fail(`${what} is missing.`);
  return parseXml(decodeUtf8(readZipEntryData(found.entry)), what);
}

function assertOnlyAllowedAttributes(element: XmlElement, what: string, allowedAttributes: Set<string>) {
  for (const attribute of Array.from(element.attributes)) {
    const attributeName = attribute.name;
    if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) continue;
    if (allowedAttributes.has(attributeName)) continue;
    fail(`${what} still carries attribute ${attributeName}.`);
  }
}

// A properties part is scrubbed when its root carries nothing but namespace
// declarations (plus explicitly allowed attributes) and has no children and
// no forbidden content. The verifier checks emptiness rather than
// byte-comparing against the cleaner's templates so both sides stay independent.
function assertScrubbedPart(
  entries: Map<string, VerifiedEntry>,
  name: string,
  expectedRootLocalName: string,
  allowedAttributes: Set<string>
) {
  const document = entryXml(entries, name, name);
  const root = document.documentElement as unknown as XmlElement;
  if (localName(root) !== expectedRootLocalName.toLowerCase()) {
    fail(`${name} has an unexpected root element.`);
  }
  assertOnlyAllowedAttributes(root, name, allowedAttributes);
  if (elementChildren(root).length > 0 || hasForbiddenNonElementContent(root)) {
    fail(`${name} still contains metadata.`);
  }
}

// --- OOXML -------------------------------------------------------------------

// Declared independently of the cleaner on purpose (see module comment).
const OOXML_ALLOWED_DOCPROPS = new Map([
  ["docProps/core.xml", "coreProperties"],
  ["docProps/app.xml", "Properties"],
  ["docProps/custom.xml", "Properties"]
]);

function verifyOoxml(entries: Map<string, VerifiedEntry>) {
  if (!entries.has("[Content_Types].xml") || !entries.has("_rels/.rels")) {
    fail("Not a valid OOXML package.");
  }

  // OPC part names are case-insensitive and relationship Targets may be written
  // "./x", "%2Fx" or "/x"; resolve to the actual entry name the same way the
  // cleaner does so a hidden property part cannot slip through.
  const byLowerName = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name] as const));
  const actualEntryName = (target: string) => byLowerName.get(resolveOpcTarget(target).toLowerCase());

  for (const name of entries.keys()) {
    if (name.toLowerCase().startsWith("docprops/") && !OOXML_ALLOWED_DOCPROPS.has(name)) {
      fail(`Forbidden package part ${name} survived cleaning.`);
    }
  }

  for (const [name, rootLocalName] of OOXML_ALLOWED_DOCPROPS) {
    if (entries.has(name)) assertScrubbedPart(entries, name, rootLocalName, new Set());
  }

  // Package relationships may not point at a surviving thumbnail. Property
  // parts are legal anywhere in OPC (the relationship, not the path, defines
  // them), so every reachable property part — standard docProps location or
  // not — must be scrubbed empty, exactly like the checks above.
  const rels = entryXml(entries, "_rels/.rels", "package relationships");
  const propertyChecks: Array<[RegExp, string]> = [
    [/\/metadata\/core-properties$/i, "coreProperties"],
    [/\/extended-properties$/i, "Properties"],
    [/\/custom-properties$/i, "Properties"]
  ];
  for (const relationship of Array.from(rels.getElementsByTagName("Relationship"))) {
    if ((relationship.getAttribute("TargetMode") ?? "").toLowerCase() === "external") continue;
    const type = relationship.getAttribute("Type") ?? "";
    const target = relationship.getAttribute("Target") ?? "";
    // A dangling relationship (no such entry) references nothing and can leak
    // nothing; only an existing target can carry recoverable data.
    const actual = actualEntryName(target);
    if (!actual) continue;
    if (/\/metadata\/thumbnail$/i.test(type)) {
      fail("A thumbnail relationship survived cleaning.");
    }
    for (const [pattern, rootLocalName] of propertyChecks) {
      if (pattern.test(type)) {
        assertScrubbedPart(entries, actual, rootLocalName, new Set());
      }
    }
  }
}

// --- ODF ---------------------------------------------------------------------

function verifyOdf(entries: Map<string, VerifiedEntry>) {
  if (!entries.has("content.xml") || !entries.has("META-INF/manifest.xml")) {
    fail("Not a valid ODF package.");
  }

  for (const name of entries.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith("thumbnails/") && lower !== "thumbnails/") {
      fail(`Thumbnail ${name} survived cleaning.`);
    }
  }

  if (entries.has("meta.xml")) {
    const document = entryXml(entries, "meta.xml", "ODF metadata");
    const root = document.documentElement as unknown as XmlElement;
    if (localName(root) !== "document-meta") fail("meta.xml has an unexpected root element.");
    // Attributes are an unchecked byte channel unless policed, exactly like the
    // OOXML property parts. The cleaner's template emits office:version="1.2"
    // on the root and no attributes on <office:meta>.
    assertOnlyAllowedAttributes(root, "meta.xml", new Set(["office:version"]));
    const children = elementChildren(root);
    if (children.length > 1 || hasForbiddenNonElementContent(root)) fail("meta.xml still contains metadata.");
    if (children.length === 1) {
      const meta = children[0];
      if (localName(meta) !== "meta") fail("meta.xml has an unexpected child element.");
      assertOnlyAllowedAttributes(meta, "meta.xml", new Set());
      if (elementChildren(meta).length > 0 || hasForbiddenNonElementContent(meta)) {
        fail("meta.xml still contains metadata.");
      }
    }
  }
}

// --- EPUB --------------------------------------------------------------------

// Declared independently of the cleaner on purpose (see module comment).
const EPUB_FORBIDDEN_DC_ELEMENTS = new Set([
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

const EPUB_ALLOWED_META_PROPERTY = /^(rendition:|media:|schema:access|ibooks:)/;
const EPUB_IDENTIFIER = /^urn:freshfile:[0-9a-f]{32}$/;
const EPUB_NEUTRAL_MODIFIED = "1980-01-01T00:00:00Z";

function verifyOpfMetadata(opf: ReturnType<typeof parseXml>) {
  const metadataElements = Array.from(opf.getElementsByTagName("*")).filter((element) =>
    ["metadata", "dc-metadata", "x-metadata"].includes(localName(element as XmlElement))
  ) as XmlElement[];

  for (const metadata of metadataElements) {
    for (const element of elementChildren(metadata)) {
      const name = localName(element);
      if (EPUB_FORBIDDEN_DC_ELEMENTS.has(name)) {
        fail(`EPUB metadata element ${name} survived cleaning.`);
      }
      if (name === "identifier") {
        const text = (element.textContent ?? "").trim();
        if (!EPUB_IDENTIFIER.test(text)) fail("EPUB identifier was not anonymized.");
        continue;
      }
      if (name === "meta") {
        const property = element.getAttribute("property")?.toLowerCase() ?? "";
        const metaName = element.getAttribute("name")?.toLowerCase() ?? "";
        if (property === "dcterms:modified") {
          if ((element.textContent ?? "").trim() !== EPUB_NEUTRAL_MODIFIED) {
            fail("EPUB modification date was not neutralized.");
          }
          continue;
        }
        if (EPUB_ALLOWED_META_PROPERTY.test(property) || metaName === "cover") continue;
        fail("An EPUB meta element survived cleaning.");
      }
    }
  }
}

function verifyEpub(entries: Map<string, VerifiedEntry>) {
  const container = entryXml(entries, "META-INF/container.xml", "EPUB container");
  // The container may list several renditions; each OPF carries its own
  // metadata, so every one is verified (matching the cleaner, which now cleans
  // all of them).
  const opfPaths = Array.from(container.getElementsByTagName("rootfile"))
    .map((rootfile) => rootfile.getAttribute("full-path"))
    .filter((path): path is string => Boolean(path))
    .map((path) => path.replace(/^\//, ""));
  if (opfPaths.length === 0) fail("EPUB container has no rootfile.");

  for (const opfPath of new Set(opfPaths)) {
    verifyOpfMetadata(entryXml(entries, opfPath, "EPUB package document"));
  }
}

// --- RTF ---------------------------------------------------------------------

// Declared independently of the cleaner (same list, own symbol). Bare words;
// an optional \* ignorable-destination prefix is matched separately, and a
// metadata word only matches when the character after it is not another letter
// (so CR/LF/TAB/digit delimiters are honoured, and {\*\info …} is caught).
const RTF_FORBIDDEN_GROUPS = ["\\info", "\\generator", "\\userprops", "\\passwordhash", "\\docvar"];

function isEscapedBrace(text: string, index: number) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

export function verifyCleanedRtfText(text: string) {
  if (!/^\s*\{\\rtf/.test(text)) fail("Not a cleaned RTF document.");
  if (/\\bin\d/.test(text)) fail("RTF embedded binary data survived cleaning.");

  for (let index = text.indexOf("{"); index !== -1; index = text.indexOf("{", index + 1)) {
    if (isEscapedBrace(text, index)) continue;
    let pos = index + 1;
    if (text.startsWith("\\*", pos)) pos += 2;
    for (const word of RTF_FORBIDDEN_GROUPS) {
      if (!text.startsWith(word, pos)) continue;
      const after = text[pos + word.length];
      if (after === undefined || !/[A-Za-z]/.test(after)) {
        fail(`RTF metadata group ${word} survived cleaning.`);
      }
    }
  }
}

// --- Dispatch ------------------------------------------------------------------

export function verifyCleanedOfficeBytes(bytes: Uint8Array, format: string) {
  if (OOXML_FORMATS.has(format)) {
    verifyOoxml(verifyZipStructure(bytes));
    return;
  }
  if (ODF_FORMATS.has(format)) {
    verifyOdf(verifyZipStructure(bytes));
    return;
  }
  if (format === "epub") {
    verifyEpub(verifyZipStructure(bytes));
    return;
  }
  if (format === "rtf") {
    verifyCleanedRtfText(decodeLatin1(bytes));
    return;
  }
  fail(`No package verifier for format ${format}.`);
}
