import { describe, expect, it } from "vitest";
import { cleanEpubPackage, cleanOdfPackage, cleanOoxmlPackage, cleanRtfText } from "@/formats/office-cleaner";
import { PackageVerificationError, verifyCleanedOfficeBytes } from "@/formats/office-verifier";
import { readZipEntries, readZipEntryData, rebuildZip } from "@/formats/zip-rewriter";
import { buildZip } from "./helpers/build-zip";

// Rebuild a fixture through the real ZIP writer so it passes verifyZipStructure
// (epoch timestamps, canonical layout) and the per-format POLICY code runs,
// rather than the negative fixtures tripping on the timestamp check first.
const normalize = (bytes: Uint8Array) => rebuildZip(readZipEntries(bytes));

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`;
const DIRTY_CORE = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator></cp:coreProperties>`;
const DIRTY_APP = `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Secret GmbH</Company></Properties>`;
const APPLE_META = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><meta xmlns="http://schemas.apple.com/cocoa/2006/metadata"><generator>CocoaOOXMLWriter/2685.6</generator></meta>`;

function relationships(extra = "") {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>${extra}</Relationships>`;
}

function buildDirtyDocx() {
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    {
      name: "_rels/.rels",
      data: relationships(
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="media/preview.jpeg"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="props/extended.xml"/>`
      )
    },
    { name: "word/document.xml", data: DOCUMENT },
    { name: "docProps/core.xml", data: DIRTY_CORE },
    { name: "docProps/meta.xml", data: APPLE_META },
    // Thumbnail outside docProps/, only reachable through its relationship.
    { name: "media/preview.jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    // Extended properties at a non-standard path, reachable through rId4.
    { name: "props/extended.xml", data: DIRTY_APP },
    // Casing variant that a case-sensitive sweep would miss.
    { name: "DocProps/evil.xml", data: APPLE_META }
  ]);
}

function entryNames(bytes: Uint8Array) {
  return readZipEntries(bytes).map((entry) => entry.name);
}

function entryText(bytes: Uint8Array, name: string) {
  const entry = readZipEntries(bytes).find((candidate) => candidate.name === name);
  return entry ? Buffer.from(readZipEntryData(entry)).toString("utf8") : null;
}

describe("verifyCleanedOfficeBytes — OOXML", () => {
  it("accepts the cleaner's output and confirms exotic parts are gone", () => {
    const cleaned = cleanOoxmlPackage(buildDirtyDocx());
    expect(() => verifyCleanedOfficeBytes(cleaned, "docx")).not.toThrow();

    const names = entryNames(cleaned);
    expect(names).not.toContain("docProps/meta.xml");
    expect(names).not.toContain("DocProps/evil.xml");
    expect(names).not.toContain("media/preview.jpeg");
    expect(entryText(cleaned, "docProps/core.xml")).not.toContain("Secret");
    expect(entryText(cleaned, "props/extended.xml")).not.toContain("Secret GmbH");
    expect(entryText(cleaned, "word/document.xml")).toContain("Hello");
  });

  it("rejects the uncleaned package on the forbidden-part policy branch", () => {
    expect(() => verifyCleanedOfficeBytes(normalize(buildDirtyDocx()), "docx")).toThrow(/Forbidden package part/);
  });

  it("rejects a forbidden docProps part even in a rebuilt package", () => {
    const withMeta = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: relationships() },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "docProps/meta.xml", data: APPLE_META }
    ]);
    // Rebuild normalizes timestamps but must not hide the forbidden part:
    // clean a copy WITHOUT meta.xml, then verify the one WITH it fails on the
    // part check rather than only on timestamps.
    expect(() => verifyCleanedOfficeBytes(cleanOoxmlPackage(withMeta), "docx")).not.toThrow();
    expect(() => verifyCleanedOfficeBytes(normalize(withMeta), "docx")).toThrow(/Forbidden package part docProps\/meta\.xml/);
  });

  it("rejects bytes appended after the end record", () => {
    const cleaned = cleanOoxmlPackage(buildDirtyDocx());
    const padded = Buffer.concat([Buffer.from(cleaned), Buffer.from("EXFIL")]);
    expect(() => verifyCleanedOfficeBytes(padded, "docx")).toThrow(PackageVerificationError);
  });

  it("rejects bytes prepended before the first entry", () => {
    const cleaned = cleanOoxmlPackage(buildDirtyDocx());
    const padded = Buffer.concat([Buffer.from("EXFIL"), Buffer.from(cleaned)]);
    expect(() => verifyCleanedOfficeBytes(padded, "docx")).toThrow(PackageVerificationError);
  });

  it("rejects a tampered timestamp", () => {
    const cleaned = Buffer.from(cleanOoxmlPackage(buildDirtyDocx()));
    cleaned.writeUInt16LE(0x7000, 10); // first local header's mod time
    expect(() => verifyCleanedOfficeBytes(cleaned, "docx")).toThrow(/epoch/);
  });

  it("rejects local extra fields (they can carry timestamps)", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: relationships() },
      { name: "word/document.xml", data: DOCUMENT, localExtraField: Buffer.from("UT\x05\x00\x01secret", "latin1") }
    ]);
    expect(() => verifyCleanedOfficeBytes(zip, "docx")).toThrow(PackageVerificationError);
  });

  it("rejects duplicate entry names", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: relationships() },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "word/document.xml", data: DOCUMENT }
    ]);
    expect(() => cleanOoxmlPackage(zip)).toThrow(/Duplicate/);
  });

  it("rejects a surviving thumbnail relationship", () => {
    // A package whose rels still advertise a thumbnail — regardless of
    // whether the part exists — must fail.
    const zip = cleanOoxmlPackage(
      buildZip([
        { name: "[Content_Types].xml", data: CONTENT_TYPES },
        { name: "_rels/.rels", data: relationships() },
        { name: "word/document.xml", data: DOCUMENT }
      ])
    );
    const text = entryText(zip, "_rels/.rels")!;
    expect(text).not.toContain("thumbnail");
    // Craft the failure case directly (bypassing the cleaner) to prove the
    // verifier stands on its own.
    const crafted = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      {
        name: "_rels/.rels",
        data: relationships(
          `<Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="media/preview.jpeg"/>`
        )
      },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "media/preview.jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(crafted), "docx")).toThrow(/thumbnail relationship/);
  });
});

describe("verifyCleanedOfficeBytes — ODF", () => {
  const MANIFEST = `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  const ODF_CONTENT = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>`;
  const DIRTY_ODF_META = `<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator>LibreOffice/25.2</meta:generator></office:meta></office:document-meta>`;

  function buildDirtyOdt() {
    return buildZip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.text", stored: true },
      { name: "content.xml", data: ODF_CONTENT },
      { name: "meta.xml", data: DIRTY_ODF_META },
      { name: "META-INF/manifest.xml", data: MANIFEST },
      { name: "Thumbnails/thumbnail.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: "THUMBNAILS/sneaky.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    ]);
  }

  it("accepts the cleaner's output and confirms thumbnails are gone in any casing", () => {
    const cleaned = cleanOdfPackage(buildDirtyOdt());
    expect(() => verifyCleanedOfficeBytes(cleaned, "odt")).not.toThrow();
    const names = entryNames(cleaned);
    expect(names).not.toContain("Thumbnails/thumbnail.png");
    expect(names).not.toContain("THUMBNAILS/sneaky.png");
    expect(entryText(cleaned, "meta.xml")).not.toContain("LibreOffice");
  });

  it("rejects the uncleaned package on a policy branch", () => {
    expect(() => verifyCleanedOfficeBytes(normalize(buildDirtyOdt()), "odt")).toThrow(/survived cleaning|still contains metadata/);
  });
});

describe("verifyCleanedOfficeBytes — EPUB", () => {
  const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

  function buildEpub(opf: string) {
    return buildZip([
      { name: "mimetype", data: "application/epub+zip", stored: true },
      { name: "META-INF/container.xml", data: CONTAINER },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/chapter1.xhtml", data: "<html><body>Text</body></html>" }
    ]);
  }

  const DIRTY_OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:creator>Secret Author</dc:creator><dc:identifier id="pub-id">store-issued-9137</dc:identifier><meta property="dcterms:modified">2024-05-01T10:00:00Z</meta><meta name="calibre:series" content="Private"/></metadata><manifest/><spine/></package>`;

  it("accepts the cleaner's output", () => {
    const cleaned = cleanEpubPackage(buildEpub(DIRTY_OPF));
    expect(() => verifyCleanedOfficeBytes(cleaned, "epub")).not.toThrow();
  });

  it("rejects the uncleaned package on the metadata policy branch", () => {
    expect(() => verifyCleanedOfficeBytes(normalize(buildEpub(DIRTY_OPF)), "epub")).toThrow(/survived cleaning/);
  });

  it("rejects a non-anonymized identifier even when everything else is clean", () => {
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:identifier>store-issued-9137</dc:identifier></metadata><manifest/><spine/></package>`;
    const rebuilt = cleanEpubPackage(buildEpub(opf));
    // cleanEpubPackage anonymizes it, so craft the bad state manually.
    expect(() => verifyCleanedOfficeBytes(rebuilt, "epub")).not.toThrow();
    expect(() => verifyCleanedOfficeBytes(normalize(buildEpub(opf)), "epub")).toThrow(/identifier was not anonymized/);
  });
});

describe("verifyCleanedOfficeBytes — RTF", () => {
  it("accepts cleaned RTF and rejects surviving metadata groups", () => {
    const dirty = String.raw`{\rtf1\ansi{\info{\author Secret}}{\*\generator TextEdit}Hello}`;
    const cleaned = cleanRtfText(dirty);
    expect(() => verifyCleanedOfficeBytes(Buffer.from(cleaned, "latin1"), "rtf")).not.toThrow();
    expect(() => verifyCleanedOfficeBytes(Buffer.from(dirty, "latin1"), "rtf")).toThrow(/\\info/);
  });

  it("does not flag escaped braces as group openers", () => {
    const text = String.raw`{\rtf1\ansi literal \{\info not a group\} end}`;
    expect(() => verifyCleanedOfficeBytes(Buffer.from(text, "latin1"), "rtf")).not.toThrow();
  });

  it("fails closed on unknown formats", () => {
    expect(() => verifyCleanedOfficeBytes(Buffer.from("x"), "wat")).toThrow(PackageVerificationError);
  });
});
