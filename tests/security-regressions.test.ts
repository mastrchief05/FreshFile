import { describe, expect, it } from "vitest";
import { cleanGif } from "@/gif-cleaner";
import { cleanMp3 } from "@/mp3-cleaner";
import { cleanFlac } from "@/flac-cleaner";
import { cleanJpeg } from "@/client-image-cleaner";
import { cleanSvg } from "@/svg-cleaner";
import { cleanRtfText } from "@/office-cleaner";
import { verifyCleanedOfficeBytes } from "@/office-verifier";
import { readZipEntries, ZipRewriteError, crc32 } from "@/zip-rewriter";
import { encodeLatin1 } from "@/bytes";
import { validateUploadedFile, UploadValidationError } from "@/file-validation";

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const toLatin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

// A JPEG that cleanJpeg accepts: SOI, a DQT segment, SOS with 2 bytes of
// entropy data, EOI.
const MINIMAL_JPEG = new Uint8Array([
  0xff, 0xd8, // SOI
  0xff, 0xdb, 0x00, 0x05, 0x00, 0x01, 0x02, // DQT (len 5)
  0xff, 0xda, 0x00, 0x03, 0x00, // SOS header (len 3)
  0x12, 0x34, // entropy-coded data
  0xff, 0xd9 // EOI
]);

// --- #4 MP3 appended ID3v2.4 (footer) tag -----------------------------------

describe("security: MP3 appended ID3v2.4 footer tag", () => {
  it("strips an ID3v2.4 tag located by its trailing 3DI footer", () => {
    const frames = [0xff, 0xfb, 0x90, 0x00, ...Array(60).fill(0xaa)];
    const tagBody = ascii("GEOB") .concat(ascii("secret gps here"));
    // Header "ID3" 2 4 flags=0x10(footer present) size(synchsafe), body, footer "3DI".
    const size = tagBody.length;
    const synch = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
    const header = [...ascii("ID3"), 4, 0, 0x10, ...synch];
    const footer = [...ascii("3DI"), 4, 0, 0x10, ...synch];
    const mp3 = new Uint8Array([...frames, ...header, ...tagBody, ...footer]);

    const { bytes, removed } = cleanMp3(mp3);
    expect(toLatin1(bytes)).not.toContain("secret gps here");
    expect(removed).toContain("id3");
  });
});

// --- #5 JPEG post-EOI trailer -----------------------------------------------

describe("security: JPEG trailing data after EOI", () => {
  it("drops an appended trailer (Motion-Photo / stego) after the EOI marker", () => {
    const trailer = ascii("APPENDED_MP4_WITH_GPS");
    const withTrailer = new Uint8Array([...MINIMAL_JPEG, ...trailer]);
    const result = cleanJpeg(withTrailer);
    expect(toLatin1(result.cleaned)).not.toContain("APPENDED_MP4_WITH_GPS");
    expect(result.cleaned[result.cleaned.length - 2]).toBe(0xff);
    expect(result.cleaned[result.cleaned.length - 1]).toBe(0xd9);
    expect(result.removed).toContain("Trailing data after EOI");
  });

  it("leaves a clean JPEG with no trailer unchanged in length", () => {
    const result = cleanJpeg(MINIMAL_JPEG);
    expect(result.removed).not.toContain("Trailing data after EOI");
  });
});

// --- #6 GIF plain-text / unknown extension blocks ---------------------------

describe("security: GIF non-standard extension blocks", () => {
  const header = [...ascii("GIF89a"), 1, 0, 1, 0, 0x00, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];
  const graphicControl = [0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00];
  const plainText = [0x21, 0x01, 12, ...Array(12).fill(0x20), 5, ...ascii("hello"), 0];
  const unknownExt = [0x21, 0x77, 6, ...ascii("secret"), 0];

  it("drops plain-text and unknown extensions but keeps graphic control", () => {
    const gif = new Uint8Array([...header, ...graphicControl, ...plainText, ...unknownExt, ...frame, 0x3b]);
    const { bytes, removed } = cleanGif(gif);
    const text = toLatin1(bytes);
    expect(text).not.toContain("hello");
    expect(text).not.toContain("secret");
    expect(removed).toEqual(expect.arrayContaining(["ext:0x01", "ext:0x77"]));
    // Graphic control extension (0xf9) is preserved.
    expect(bytes).toContain(0xf9);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });
});

// --- #7/#9 SVG <title> and editor namespaces --------------------------------

describe("security: SVG metadata channels", () => {
  it("removes <title> and editor-namespace attributes", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd" sodipodi:docname="/Users/leon/secret-invoice.svg"><title>Author: Leon Metz</title><rect width="10" height="10"/></svg>`;
    const cleaned = cleanSvg(svg);
    expect(cleaned).not.toContain("secret-invoice");
    expect(cleaned).not.toContain("sodipodi");
    expect(cleaned).not.toContain("Author: Leon Metz");
    expect(cleaned).not.toContain("<title");
    expect(cleaned).toContain("<rect");
  });
});

// --- #8 RTF passwordhash / docvar -------------------------------------------

describe("security: RTF metadata destinations", () => {
  it("strips \\*\\passwordhash and \\*\\docvar groups", () => {
    const dirty = String.raw`{\rtf1\ansi{\*\passwordhash 00aabbccdd}{\*\docvar {\dvname Client}{\dvval Acme Secret}}Body}`;
    const cleaned = cleanRtfText(dirty);
    expect(cleaned).not.toContain("aabbccdd");
    expect(cleaned).not.toContain("Acme Secret");
    expect(() => verifyCleanedOfficeBytes(encodeLatin1(cleaned), "rtf")).not.toThrow();
    expect(() => verifyCleanedOfficeBytes(encodeLatin1(dirty), "rtf")).toThrow(/passwordhash|docvar/);
  });
});

// --- #10 FLAC CUESHEET sanitize ---------------------------------------------

describe("security: FLAC CUESHEET identifying fields", () => {
  it("zeroes the media catalog number while keeping the block", () => {
    const streaminfo = Array(34).fill(0x11);
    // CUESHEET body: 128-byte catalog (secret) + 8 lead-in + 1 flags + 258 reserved + 1 track count(0).
    const catalog = ascii("SECRETCATALOG12345".padEnd(128, "\0"));
    const cuesheet = [...catalog, ...Array(8).fill(0), 0x80, ...Array(258).fill(0), 0];
    const parts: number[] = [...ascii("fLaC")];
    parts.push(0x00, 0, 0, streaminfo.length, ...streaminfo); // STREAMINFO
    parts.push(0x80 | 5, (cuesheet.length >> 16) & 0xff, (cuesheet.length >> 8) & 0xff, cuesheet.length & 0xff, ...cuesheet); // last = CUESHEET
    parts.push(0xff, 0xf8, 0x69, 0x18);
    const { bytes, removed } = cleanFlac(new Uint8Array(parts));
    expect(toLatin1(bytes)).not.toContain("SECRETCATALOG");
    expect(removed).toContain("cuesheetMetadata");
  });
});

// --- #3 ZIP entry-slice memory amplification --------------------------------

describe("security: ZIP overlapping-entry amplification", () => {
  it("rejects a central directory whose entries' data exceeds the archive size", () => {
    // One large stored local entry, then TWO central records both pointing at
    // it — cumulative compressed bytes (2x) exceed the file length.
    const name = Buffer.from("a.bin", "utf8");
    const data = Buffer.alloc(4096, 0x41);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([local, name, data]);

    function central() {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0, 10); // stored
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(data.length, 20);
      c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(0, 42); // both point at local header offset 0
      return Buffer.concat([c, name]);
    }
    const centralA = central();
    const centralB = Buffer.concat([central()]);
    // Give the two central entries distinct names so the duplicate-name guard
    // does not fire first — we want the size guard to be what rejects it.
    centralB.write("b.bin", 46, "utf8");

    const centralOffset = localPart.length;
    const centralDir = Buffer.concat([centralA, centralB]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(2, 8);
    eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);

    const zip = Buffer.concat([localPart, centralDir, eocd]);
    expect(() => readZipEntries(zip)).toThrow(ZipRewriteError);
  });
});

// --- #11 plain-text validation bypass ---------------------------------------

describe("security: plain-text fallback does not override magic detection", () => {
  it("rejects a PDF body named .csv instead of a no-op text clean", async () => {
    // A minimal PDF whose head has no NUL bytes (would pass looksLikePlainText).
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Author(Leon Metz)/Title(Secret)>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
      "latin1"
    );
    await expect(validateUploadedFile(pdf, "invoice.csv", "text/csv")).rejects.toBeInstanceOf(UploadValidationError);
  });

  it("still accepts a genuine CSV (no magic bytes)", async () => {
    const csv = Buffer.from("name,price\nPixel 9,899\n", "utf8");
    await expect(validateUploadedFile(csv, "data.csv", "text/csv")).resolves.toMatchObject({ format: "csv" });
  });
});
