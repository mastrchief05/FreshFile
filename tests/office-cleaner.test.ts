import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  cleanEpubPackage,
  cleanOdfPackage,
  cleanOoxmlPackage,
  cleanRtfText,
  OfficeCleanerError
} from "@/formats/office-cleaner";
import { crc32, readZipEntries, readZipEntryData, rebuildZip } from "@/formats/zip-rewriter";

type FixtureEntry = {
  name: string;
  data: string | Buffer;
  stored?: boolean;
};

// Builds a real ZIP (deflate by default, stored on demand) without external deps.
function buildZip(entries: FixtureEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.stored ? 0 : 8;
    const compressed = entry.stored ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x7000, 10); // deliberate non-epoch timestamp
    local.writeUInt16LE(0x5a21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x7000, 12);
    central.writeUInt16LE(0x5a21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function entryText(bytes: Uint8Array, name: string) {
  const entry = readZipEntries(bytes).find((candidate) => candidate.name === name);
  return entry ? new TextDecoder().decode(readZipEntryData(entry)) : null;
}

const DOCX_CORE = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator><cp:lastModifiedBy>Secret Editor</cp:lastModifiedBy></cp:coreProperties>`;
const DOCX_APP = `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><Company>Secret GmbH</Company><TotalTime>842</TotalTime></Properties>`;
const DOCX_DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body></w:document>`;

function buildDocx() {
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>`
    },
    { name: "word/document.xml", data: DOCX_DOCUMENT },
    { name: "docProps/core.xml", data: DOCX_CORE },
    { name: "docProps/app.xml", data: DOCX_APP },
    { name: "docProps/thumbnail.jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
  ]);
}

describe("zip rewriter", () => {
  it("round-trips entries and resets timestamps to the DOS epoch", () => {
    const original = buildZip([{ name: "a.txt", data: "hello" }, { name: "b.bin", data: Buffer.from([1, 2, 3]), stored: true }]);
    const rebuilt = rebuildZip(readZipEntries(original));
    const entries = readZipEntries(rebuilt);

    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "b.bin"]);
    expect(new TextDecoder().decode(readZipEntryData(entries[0]))).toBe("hello");
    expect(Array.from(readZipEntryData(entries[1]))).toEqual([1, 2, 3]);
    // Local header timestamp bytes must be the DOS epoch.
    expect(rebuilt[10] | (rebuilt[11] << 8)).toBe(0);
    expect(rebuilt[12] | (rebuilt[13] << 8)).toBe(0x21);
  });

  it("replaces and removes entries", () => {
    const original = buildZip([{ name: "keep.txt", data: "keep" }, { name: "swap.txt", data: "old" }, { name: "drop.txt", data: "x" }]);
    const rebuilt = rebuildZip(readZipEntries(original), {
      replace: new Map([["swap.txt", Buffer.from("new")]]),
      remove: new Set(["drop.txt"])
    });

    expect(entryText(rebuilt, "keep.txt")).toBe("keep");
    expect(entryText(rebuilt, "swap.txt")).toBe("new");
    expect(entryText(rebuilt, "drop.txt")).toBeNull();
  });
});

describe("office cleaner", () => {
  it("cleans OOXML docProps, drops the thumbnail, and keeps document content byte-identical", () => {
    const cleaned = cleanOoxmlPackage(buildDocx());

    expect(entryText(cleaned, "word/document.xml")).toBe(DOCX_DOCUMENT);
    expect(entryText(cleaned, "docProps/core.xml")).not.toContain("Secret");
    expect(entryText(cleaned, "docProps/app.xml")).not.toContain("Microsoft");
    expect(entryText(cleaned, "docProps/app.xml")).not.toContain("Secret GmbH");
    expect(entryText(cleaned, "docProps/thumbnail.jpeg")).toBeNull();
    expect(entryText(cleaned, "_rels/.rels")).not.toContain("thumbnail");
    expect(entryText(cleaned, "_rels/.rels")).toContain("word/document.xml");
  });

  it("drops non-standard docProps parts like Apple's meta.xml, including their references", () => {
    const docx = buildZip([
      {
        name: "[Content_Types].xml",
        data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/meta.xml" ContentType="application/xml"/></Types>`
      },
      {
        name: "_rels/.rels",
        data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId4" Type="http://schemas.apple.com/cocoa/2006/metadata" Target="docProps/meta.xml"/></Relationships>`
      },
      { name: "word/document.xml", data: DOCX_DOCUMENT },
      {
        name: "docProps/meta.xml",
        data: `<meta xmlns="http://schemas.apple.com/cocoa/2006/metadata"><generator>CocoaOOXMLWriter/2685.6</generator></meta>`
      }
    ]);

    const cleaned = cleanOoxmlPackage(docx);

    expect(entryText(cleaned, "docProps/meta.xml")).toBeNull();
    expect(entryText(cleaned, "word/document.xml")).toBe(DOCX_DOCUMENT);
    expect(entryText(cleaned, "_rels/.rels")).not.toContain("meta.xml");
    expect(entryText(cleaned, "[Content_Types].xml")).not.toContain("meta.xml");
  });

  it("cleans ODF meta.xml and thumbnails while preserving mimetype-first stored layout", () => {
    const content = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body/></office:document-content>`;
    const odt = buildZip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.text", stored: true },
      { name: "content.xml", data: content },
      {
        name: "meta.xml",
        data: `<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><meta:generator>LibreOffice/7.6</meta:generator><meta:initial-creator>Secret Person</meta:initial-creator></office:meta></office:document-meta>`
      },
      { name: "Thumbnails/thumbnail.png", data: Buffer.from([0x89, 0x50]) },
      {
        name: "META-INF/manifest.xml",
        data: `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/></manifest:manifest>`
      }
    ]);

    const cleaned = cleanOdfPackage(odt);
    const entries = readZipEntries(cleaned);

    expect(entries[0].name).toBe("mimetype");
    expect(entries[0].compressionMethod).toBe(0);
    expect(entryText(cleaned, "content.xml")).toBe(content);
    expect(entryText(cleaned, "meta.xml")).not.toContain("Secret");
    expect(entryText(cleaned, "meta.xml")).not.toContain("LibreOffice");
    expect(entryText(cleaned, "Thumbnails/thumbnail.png")).toBeNull();
    expect(entryText(cleaned, "META-INF/manifest.xml")).not.toContain("Thumbnails");
  });

  it("cleans EPUB OPF metadata but keeps identifier, title, and language", () => {
    const epub = buildZip([
      { name: "mimetype", data: "application/epub+zip", stored: true },
      {
        name: "META-INF/container.xml",
        data: `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
      },
      {
        name: "OEBPS/content.opf",
        data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:1234</dc:identifier><dc:title>My Book</dc:title><dc:language>en</dc:language><dc:creator>Secret Writer</dc:creator><dc:publisher>Secret Press</dc:publisher><meta property="dcterms:modified">2026-07-01T10:00:00Z</meta><meta name="calibre:author_link_map" content="secret"/></metadata><manifest/><spine/></package>`
      },
      { name: "OEBPS/chapter1.xhtml", data: "<html><body>Text</body></html>" }
    ]);

    const cleaned = cleanEpubPackage(epub);
    const opf = entryText(cleaned, "OEBPS/content.opf") ?? "";

    expect(opf).not.toContain("urn:uuid:1234");
    expect(opf).toContain("urn:freshfile:");
    expect(opf).toContain("My Book");
    expect(opf).toContain("dc:language");
    expect(opf).not.toContain("Secret Writer");
    expect(opf).not.toContain("Secret Press");
    expect(opf).not.toContain("calibre");
    expect(opf).toContain("1980-01-01T00:00:00Z");
    expect(entryText(cleaned, "OEBPS/chapter1.xhtml")).toBe("<html><body>Text</body></html>");
  });

  it("strips RTF info and generator groups while keeping the document text", () => {
    const rtf = `{\\rtf1\\ansi{\\info{\\author Secret Author}{\\operator Secret Op}{\\creatim\\yr2026\\mo7\\dy3}}{\\*\\generator Riched20 10.0}Hello {\\b World}}`;
    const cleaned = cleanRtfText(rtf);

    expect(cleaned).toContain("Hello {\\b World}");
    expect(cleaned).not.toContain("Secret");
    expect(cleaned).not.toContain("generator");
    expect(cleaned).not.toContain("creatim");
  });

  it("fails closed on unbalanced RTF groups", () => {
    expect(() => cleanRtfText("{\\rtf1{\\info{\\author x}")).toThrow(OfficeCleanerError);
  });

  it("removes many RTF metadata groups in linear time (no O(n^2) stall)", () => {
    // 50k \info groups: the old quadratic scanner would take seconds; linear
    // finishes in well under a second. Guard against regression with a budget.
    const body = "{\\info{\\author x}}".repeat(50_000);
    const rtf = `{\\rtf1\\ansi${body}Visible text}`;
    const start = Date.now();
    const cleaned = cleanRtfText(rtf);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(cleaned).toContain("Visible text");
    expect(cleaned).not.toContain("author");
  });

  it("rejects a decompression bomb: an entry that inflates past the cap", async () => {
    const zlib = await import("node:zlib");
    const { readZipEntryData, ZipRewriteError } = await import("@/formats/zip-rewriter");
    // 64 MB of zeros deflates to a few KB but inflates past the 16 MB cap.
    const bombDeflate = zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 0));
    const bombEntry = {
      nameBytes: Buffer.from("x"),
      name: "x",
      compressionMethod: 8,
      crc32: 0,
      compressedSize: bombDeflate.length,
      uncompressedSize: 1024, // lies: declares tiny, actually gigabytes
      generalPurposeFlags: 0,
      compressedData: bombDeflate
    };
    expect(() => readZipEntryData(bombEntry)).toThrow(ZipRewriteError);
  });
});
