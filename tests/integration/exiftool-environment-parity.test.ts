import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanDocumentMetadata, inspectDocumentMetadata, validateCleanedDocument } from "@/document-cleaner";
import { defaultExifToolRunner } from "@/exiftool-runner";
import { findSensitiveMetadataKeys } from "@/metadata-cleaner";
import { crc32 } from "@/zip-rewriter";

const runIntegration = process.env.RUN_EXIFTOOL_INTEGRATION === "1";

// Environment-parity guard for the ExifTool that validateCleanedDocument runs
// against. ExifTool only descends into ZIP-based documents (DOCX/XLSX/PPTX/ODF)
// when the optional Perl module Archive::Zip is installed; without it the file
// is typed as plain "ZIP" and none of its XML metadata is reported. On
// 2026-07-08 that made the Cloud Run container (Debian slim, no
// libarchive-zip-perl) silently pass a DOCX whose docProps/meta.xml the same
// ExifTool version flagged on macOS. These tests fail in any environment where
// ExifTool cannot see inside OOXML packages, so post-clean validation there
// would be weaker than what this suite verifies.

type FixtureEntry = { name: string; data: string };

function buildZip(entries: FixtureEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x7000, 10);
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
    central.writeUInt16LE(8, 10);
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

// Mirrors a textutil-converted DOCX: docProps/meta.xml is the Apple-specific
// part the 2026-07-08 incident was about, core.xml/app.xml carry the standard
// OOXML properties.
function buildDocxWithAppleMeta() {
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator></cp:coreProperties>`
    },
    {
      name: "docProps/meta.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<meta xmlns="http://schemas.apple.com/cocoa/2006/metadata"><generator>CocoaOOXMLWriter/2685.6</generator></meta>`
    }
  ]);
}

describe.skipIf(!runIntegration)("ExifTool environment parity (ZIP-based documents)", () => {
  let tempDir: string;
  let dirtyDocx: string;

  beforeAll(async () => {
    await defaultExifToolRunner(["-ver"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-parity-"));
    dirtyDocx = path.join(tempDir, "dirty.docx");
    await fs.writeFile(dirtyDocx, buildDocxWithAppleMeta());
  });

  it("sees inside OOXML packages (Archive::Zip is installed)", async () => {
    const meta = await inspectDocumentMetadata(dirtyDocx);
    // Without Archive::Zip both assertions fail: the file is typed as plain
    // "zip" and no XML: keys are reported at all.
    expect(String(meta["File:FileTypeExtension"]).toLowerCase()).toBe("docx");
    expect(meta["XML:MetaGenerator"]).toBe("CocoaOOXMLWriter/2685.6");
    expect(findSensitiveMetadataKeys(meta)).toContain("XML:MetaGenerator");
  });

  it("rejects an uncleaned DOCX instead of silently passing it", async () => {
    await expect(validateCleanedDocument(dirtyDocx, dirtyDocx, { format: "docx" })).rejects.toThrow(
      /Privacy metadata remained/
    );
  });

  it("passes validation only after cleaning removes docProps metadata", async () => {
    const cleanedDocx = path.join(tempDir, "cleaned.docx");
    await cleanDocumentMetadata(dirtyDocx, cleanedDocx, { format: "docx" });
    await expect(validateCleanedDocument(dirtyDocx, cleanedDocx, { format: "docx" })).resolves.toMatchObject({
      valid: true
    });

    const cleaned = await inspectDocumentMetadata(cleanedDocx);
    expect(String(cleaned["File:FileTypeExtension"]).toLowerCase()).toBe("docx");
    expect(cleaned["XML:MetaGenerator"]).toBeUndefined();
    expect(cleaned["XML:MetaXmlns"]).toBeUndefined();
  });
});
