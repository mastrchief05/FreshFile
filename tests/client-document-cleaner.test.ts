import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { cleanDocumentInBrowser, detectBrowserDocumentKind, ClientDocumentError } from "@/client-document-cleaner";
import { categorizeBrowserRemoved } from "@/metadata-categories";
import { readZipEntries, readZipEntryData } from "@/zip-rewriter";

// Same minimal ZIP builder the office-cleaner tests use.
type FixtureEntry = { name: string; data: string | Uint8Array; stored?: boolean };

function buildZip(entries: FixtureEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const compressed = entry.stored ? data : zlib.deflateRawSync(data);
    const method = entry.stored ? 0 : 8;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32Fallback(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, compressed);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(localParts.length / 3, 8);
  eocd.writeUInt16LE(localParts.length / 3, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, eocd]));
}

function crc32Fallback(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const DOCX_DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`;

function buildDocx() {
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    },
    { name: "word/document.xml", data: DOCX_DOCUMENT },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator></cp:coreProperties>`
    }
  ]);
}

function entryText(bytes: Uint8Array, name: string) {
  const entry = readZipEntries(bytes).find((candidate) => candidate.name === name);
  return entry ? new TextDecoder().decode(readZipEntryData(entry)) : null;
}

describe("client document cleaner", () => {
  it("detects kinds only when bytes match the extension", () => {
    const docx = buildDocx();
    expect(detectBrowserDocumentKind(docx, "letter.docx")).toBe("docx");
    expect(detectBrowserDocumentKind(new TextEncoder().encode("plain"), "letter.docx")).toBeNull();
    expect(detectBrowserDocumentKind(new TextEncoder().encode("{\\rtf1 hi}"), "a.rtf")).toBe("rtf");
    expect(detectBrowserDocumentKind(new TextEncoder().encode("<svg xmlns='x'/>"), "a.svg")).toBe("svg");
    expect(detectBrowserDocumentKind(new TextEncoder().encode("hello"), "a.txt")).toBe("txt");
    expect(detectBrowserDocumentKind(new Uint8Array([0, 1, 2]), "a.txt")).toBeNull();
    expect(detectBrowserDocumentKind(docx, "letter.pdf")).toBeNull();
  });

  it("cleans a DOCX in the browser path and reports document properties", () => {
    const result = cleanDocumentInBrowser(buildDocx(), "letter.docx");

    expect(result.strategy).toBe("package-rewrite");
    expect(result.removed).toContain("documentProperties");
    expect(entryText(result.bytes, "word/document.xml")).toBe(DOCX_DOCUMENT);
    expect(entryText(result.bytes, "docProps/core.xml")).not.toContain("Secret Author");
    expect(categorizeBrowserRemoved(result.removed)).toContain("document");
  });

  it("sanitizes SVG and strips RTF info groups", () => {
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><metadata>secret</metadata><rect width="1" height="1"/></svg>`
    );
    const svgResult = cleanDocumentInBrowser(svg, "icon.svg");
    expect(new TextDecoder().decode(svgResult.bytes)).not.toContain("secret");

    const rtf = new TextEncoder().encode(`{\\rtf1{\\info{\\author Secret}}Hello}`);
    const rtfResult = cleanDocumentInBrowser(rtf, "doc.rtf");
    expect(new TextDecoder().decode(rtfResult.bytes)).not.toContain("Secret");
    expect(new TextDecoder().decode(rtfResult.bytes)).toContain("Hello");
    expect(rtfResult.removed).toContain("rtfMetadata");
  });

  it("passes plain text through untouched", () => {
    const text = new TextEncoder().encode("hello world");
    const result = cleanDocumentInBrowser(text, "notes.txt");
    expect(result.strategy).toBe("copy-no-metadata");
    expect(result.bytes).toEqual(text);
  });

  it("fails closed on a ZIP that is not a valid package", () => {
    const zip = buildZip([{ name: "random.bin", data: "not office" }]);
    expect(() => cleanDocumentInBrowser(zip, "letter.docx")).toThrow(ClientDocumentError);
  });
});
