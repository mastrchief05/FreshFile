import { describe, expect, it } from "vitest";
import { cleanEpubPackage, cleanOfficeBuffer, cleanOoxmlPackage, cleanRtfText } from "@/office-cleaner";
import { PackageVerificationError, verifyCleanedOfficeBytes } from "@/office-verifier";
import { readZipEntries, readZipEntryData, rebuildZip } from "@/zip-rewriter";
import { encodeLatin1 } from "@/bytes";
import { buildZip } from "./helpers/build-zip";

// Regressions for the findings confirmed by the adversarial verifier review.
// `normalize` rebuilds a fixture through the real ZIP writer so its structure
// (epoch timestamps, canonical layout) passes verifyZipStructure and the
// per-format POLICY code actually runs — without this, negative fixtures fail
// on the timestamp check and never exercise what they claim to.
const normalize = (bytes: Uint8Array) => rebuildZip(readZipEntries(bytes));

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`;
const DOC_REL = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`;
const CORE_NS = `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"`;

function rels(inner: string) {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${DOC_REL}${inner}</Relationships>`;
}

// --- F2: XML comments / processing instructions bypass emptiness (critical) --

describe("regression: comment/PI channel in scrubbed parts", () => {
  it("rejects a core.xml whose root holds only a comment", () => {
    const dirty = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: rels("") },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "docProps/core.xml", data: `<cp:coreProperties ${CORE_NS}><!-- Author: Jane Doe; SSN 123-45-6789 --></cp:coreProperties>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "docx")).toThrow(/still contains metadata/);
  });

  it("rejects a core.xml whose root holds only a processing instruction", () => {
    const dirty = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: rels("") },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "docProps/core.xml", data: `<cp:coreProperties ${CORE_NS}><?leak dc:creator=JaneDoe?></cp:coreProperties>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "docx")).toThrow(/still contains metadata/);
  });

  it("rejects an ODF office:meta holding only a comment", () => {
    const dirty = buildZip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.text", stored: true },
      { name: "content.xml", data: `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>` },
      { name: "meta.xml", data: `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:meta><!-- creator: Jane Doe --></office:meta></office:document-meta>` },
      { name: "META-INF/manifest.xml", data: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "odt")).toThrow(/still contains metadata/);
  });
});

// --- F3/F9: ODF attribute channel ------------------------------------------

describe("regression: ODF meta.xml attribute channel", () => {
  const ODF_BASE = [
    { name: "mimetype", data: "application/vnd.oasis.opendocument.text", stored: true },
    { name: "content.xml", data: `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>` },
    { name: "META-INF/manifest.xml", data: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>` }
  ] as const;

  it("rejects a secret in an attribute on office:document-meta", () => {
    const dirty = buildZip([
      ...ODF_BASE,
      { name: "meta.xml", data: `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:foo="urn:x" foo:secret="LEAKED author=Leon" office:version="1.2"><office:meta/></office:document-meta>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "odt")).toThrow(/still carries attribute/);
  });

  it("rejects a secret in an attribute on office:meta", () => {
    const dirty = buildZip([
      ...ODF_BASE,
      { name: "meta.xml", data: `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:foo="urn:x" office:version="1.2"><office:meta foo:secret="ALSO-LEAKED"/></office:document-meta>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "odt")).toThrow(/still carries attribute/);
  });
});

// --- F5: duplicate / suspicious ZIP entry names -> clean rejection ----------

describe("regression: malformed ZIP entry names are rejected up front", () => {
  it("cleanOoxmlPackage throws on duplicate entry names", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: rels("") },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "word/document.xml", data: DOCUMENT }
    ]);
    expect(() => cleanOoxmlPackage(zip)).toThrow(/Duplicate/);
  });

  it("cleanOoxmlPackage throws on a backslash entry name", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: rels("") },
      { name: "word\\document.xml", data: DOCUMENT },
      { name: "word/document.xml", data: DOCUMENT }
    ]);
    expect(() => cleanOoxmlPackage(zip)).toThrow(/Suspicious/);
  });

  it("the verifier keeps its own duplicate-name backstop (epoch fixture)", () => {
    // readZipEntries rejects duplicates, so reach the verifier's independent
    // structural check via an epoch-timestamped fixture that skips the cleaner.
    const zip = buildZip(
      [
        { name: "[Content_Types].xml", data: CONTENT_TYPES },
        { name: "_rels/.rels", data: rels("") },
        { name: "word/document.xml", data: DOCUMENT },
        { name: "word/document.xml", data: DOCUMENT }
      ],
      { epoch: true }
    );
    expect(() => verifyCleanedOfficeBytes(zip, "docx")).toThrow(/Duplicate entry names/);
  });
});

// --- OPC target normalization + content-part guard --------------------------

describe("regression: OPC relationship target resolution", () => {
  const APP_NS = `xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"`;

  it("scrubs an extended-properties part reached via a './' target", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      {
        name: "_rels/.rels",
        data: rels(`<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="./props/extended.xml"/>`)
      },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "props/extended.xml", data: `<Properties ${APP_NS}><Company>Secret GmbH</Company></Properties>` }
    ]);
    const cleaned = cleanOfficeBuffer(zip, "docx");
    expect(() => verifyCleanedOfficeBytes(cleaned, "docx")).not.toThrow();
    const part = readZipEntries(cleaned).find((e) => e.name === "props/extended.xml")!;
    expect(Buffer.from(readZipEntryData(part)).toString("utf8")).not.toContain("Secret GmbH");
  });

  it("the verifier rejects a dirty property part reachable via a '%2F' target", () => {
    const dirty = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      {
        name: "_rels/.rels",
        data: rels(`<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="props%2Fextended.xml"/>`)
      },
      { name: "word/document.xml", data: DOCUMENT },
      { name: "props/extended.xml", data: `<Properties ${APP_NS}><Company>Secret GmbH</Company></Properties>` }
    ]);
    expect(() => verifyCleanedOfficeBytes(normalize(dirty), "docx")).toThrow(PackageVerificationError);
  });

  it("refuses a metadata relationship pointing at the main document (corruption guard)", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      {
        name: "_rels/.rels",
        data: rels(`<Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="word/document.xml"/>`)
      },
      { name: "word/document.xml", data: DOCUMENT }
    ]);
    expect(() => cleanOoxmlPackage(zip)).toThrow(/Suspicious OOXML metadata relationship/);
  });
});

// --- F1/F6: RTF metadata destinations & wrappers ----------------------------

describe("regression: RTF metadata groups", () => {
  const rtf = (s: string) => encodeLatin1(s);

  it("strips \\*\\userprops custom document properties", () => {
    const dirty = String.raw`{\rtf1\ansi{\*\userprops{\propname Client}{\proptype 30}{\staticval Acme Secret Corp}}\par Body}`;
    const cleaned = cleanRtfText(dirty);
    expect(cleaned).not.toContain("Acme Secret Corp");
    expect(() => verifyCleanedOfficeBytes(rtf(cleaned), "rtf")).not.toThrow();
    expect(() => verifyCleanedOfficeBytes(rtf(dirty), "rtf")).toThrow(/userprops|info/);
  });

  it("strips an info group wrapped as the ignorable destination {\\*\\info ...}", () => {
    const dirty = String.raw`{\rtf1{\*\info{\author Secret}}Hello}`;
    const cleaned = cleanRtfText(dirty);
    expect(cleaned).not.toContain("Secret");
    expect(() => verifyCleanedOfficeBytes(rtf(dirty), "rtf")).toThrow(/info/);
  });

  it("strips an info group delimited by CR/LF instead of a space", () => {
    const dirty = "{\\rtf1\\ansi{\\info\r\n{\\author Secret}}Hello}";
    const cleaned = cleanRtfText(dirty);
    expect(cleaned).not.toContain("Secret");
    expect(() => verifyCleanedOfficeBytes(rtf(dirty), "rtf")).toThrow(/info/);
  });

  it("iterates to a fixpoint so a group cannot be spliced back together", () => {
    const dirty = String.raw`{\rtf1{\i{\info X}nfo{\author Secret}}}`;
    const cleaned = cleanRtfText(dirty);
    expect(cleaned).not.toContain("{\\info");
    expect(cleaned).not.toContain("Secret");
    expect(() => verifyCleanedOfficeBytes(rtf(cleaned), "rtf")).not.toThrow();
  });
});

// --- F4: EPUB multiple rootfiles --------------------------------------------

describe("regression: EPUB multiple renditions", () => {
  const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/><rootfile full-path="OEBPS/alt.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const CLEAN_OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:identifier>urn:freshfile:00000000000000000000000000000000</dc:identifier></metadata><manifest/><spine/></package>`;
  const DIRTY_OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:creator>Secret Author</dc:creator></metadata><manifest/><spine/></package>`;

  function epub(altOpf: string) {
    return buildZip([
      { name: "mimetype", data: "application/epub+zip", stored: true },
      { name: "META-INF/container.xml", data: CONTAINER },
      { name: "OEBPS/content.opf", data: CLEAN_OPF },
      { name: "OEBPS/alt.opf", data: altOpf },
      { name: "OEBPS/chapter1.xhtml", data: "<html><body>Text</body></html>" }
    ]);
  }

  it("cleans the second rootfile's OPF too", () => {
    const cleaned = cleanEpubPackage(epub(DIRTY_OPF));
    const alt = readZipEntries(cleaned).find((e) => e.name === "OEBPS/alt.opf")!;
    expect(Buffer.from(readZipEntryData(alt)).toString("utf8")).not.toContain("Secret Author");
    expect(() => verifyCleanedOfficeBytes(cleaned, "epub")).not.toThrow();
  });

  it("the verifier rejects a package whose second rootfile OPF is dirty", () => {
    expect(() => verifyCleanedOfficeBytes(normalize(epub(DIRTY_OPF)), "epub")).toThrow(/survived cleaning/);
  });
});
