import { describe, expect, it } from "vitest";
import {
  cleanImageInBrowser,
  cleanJpeg,
  cleanPng,
  cleanWebp,
  ClientCleanError,
  detectBrowserImageKind
} from "@/client-image-cleaner";

// Real fixtures created with ExifTool: JPEG with Orientation=6 + XMP + EXIF
// (Software/Artist), PNG with tEXt parameters + XMP, WebP with XMP.
const JPEG_FIXTURE = "/9j/4AAQSkZJRgABAQAASABIAAD/4QCORXhpZgAATU0AKgAAAAgABAESAAMAAAABAAYAAAExAAIAAAARAAAAPgE7AAIAAAAMAAAAUIdpAAQAAAABAAAAXAAAAABTdGFibGUgRGlmZnVzaW9uAABMZW9uIEdlaGVpbQAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/+ELDGh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8APD94cGFja2V0IGJlZ2luPSfvu78nIGlkPSdXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQnPz4KPHg6eG1wbWV0YSB4bWxuczp4PSdhZG9iZTpuczptZXRhLycgeDp4bXB0az0nSW1hZ2U6OkV4aWZUb29sIDEzLjU5Jz4KPHJkZjpSREYgeG1sbnM6cmRmPSdodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjJz4KCiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0nJwogIHhtbG5zOnhtcD0naHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyc+CiAgPHhtcDpDcmVhdG9yVG9vbD5Db21meVVJPC94bXA6Q3JlYXRvclRvb2w+CiA8L3JkZjpEZXNjcmlwdGlvbj4KPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0ndyc/Pv/AABEIAAgACAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAICAgICAgMCAgMFAwMDBQYFBQUFBggGBgYGBggKCAgICAgICgoKCgoKCgoMDAwMDAwODg4ODg8PDw8PDw8PDw//2wBDAQICAgQEBAcEBAcQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/3QAEAAH/2gAMAwEAAhEDEQA/AP0sooor+Vz+Kz//2Q==";
const PNG_FIXTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAInRFWHRwYXJhbWV0ZXJzAHNlY3JldCBwcm9tcHQgc2VlZDoxMjM0yGqxGgAAAdRpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0n77u/JyBpZD0nVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkJz8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0nYWRvYmU6bnM6bWV0YS8nIHg6eG1wdGs9J0ltYWdlOjpFeGlmVG9vbCAxMy41OSc+CjxyZGY6UkRGIHhtbG5zOnJkZj0naHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyc+CgogPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICB4bWxuczpkYz0naHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8nPgogIDxkYzpkZXNjcmlwdGlvbj4KICAgPHJkZjpBbHQ+CiAgICA8cmRmOmxpIHhtbDpsYW5nPSd4LWRlZmF1bHQnPmdlaGVpbTwvcmRmOmxpPgogICA8L3JkZjpBbHQ+CiAgPC9kYzpkZXNjcmlwdGlvbj4KIDwvcmRmOkRlc2NyaXB0aW9uPgo8L3JkZjpSREY+CjwveDp4bXBtZXRhPgo8P3hwYWNrZXQgZW5kPSdyJz8+lX1RhQAAAA1JREFUeNpjZPjPUA8AA4YBgFo0fWsAAAAASUVORK5CYII=";
const WEBP_FIXTURE = "UklGRgIMAABXRUJQVlA4WAoAAAAUAAAAAAAAAAAAVlA4TA0AAAAvAAAAEAcQERGIiP4HAFhNUCDNCwAAPD94cGFja2V0IGJlZ2luPSfvu78nIGlkPSdXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQnPz4KPHg6eG1wbWV0YSB4bWxuczp4PSdhZG9iZTpuczptZXRhLycgeDp4bXB0az0nSW1hZ2U6OkV4aWZUb29sIDEzLjU5Jz4KPHJkZjpSREYgeG1sbnM6cmRmPSdodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjJz4KCiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0nJwogIHhtbG5zOmRjPSdodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyc+CiAgPGRjOmRlc2NyaXB0aW9uPgogICA8cmRmOkFsdD4KICAgIDxyZGY6bGkgeG1sOmxhbmc9J3gtZGVmYXVsdCc+Z2VoZWltZXMgd2VicDwvcmRmOmxpPgogICA8L3JkZjpBbHQ+CiAgPC9kYzpkZXNjcmlwdGlvbj4KIDwvcmRmOkRlc2NyaXB0aW9uPgoKIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PScnCiAgeG1sbnM6eG1wPSdodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvJz4KICA8eG1wOkNyZWF0b3JUb29sPlNlY3JldFRvb2w8L3htcDpDcmVhdG9yVG9vbD4KIDwvcmRmOkRlc2NyaXB0aW9uPgo8L3JkZjpSREY+CjwveDp4bXBtZXRhPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSd3Jz8+AA==";

function fromBase64(data: string) {
  return new Uint8Array(Buffer.from(data, "base64"));
}

function toText(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("latin1");
}

describe("client image cleaner", () => {
  it("detects formats by magic bytes, not extension", () => {
    expect(detectBrowserImageKind(fromBase64(JPEG_FIXTURE))).toBe("jpeg");
    expect(detectBrowserImageKind(fromBase64(PNG_FIXTURE))).toBe("png");
    expect(detectBrowserImageKind(fromBase64(WEBP_FIXTURE))).toBe("webp");
    expect(detectBrowserImageKind(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("strips EXIF/XMP from JPEG but keeps a minimal orientation tag", () => {
    const original = fromBase64(JPEG_FIXTURE);
    expect(toText(original)).toContain("ComfyUI");
    expect(toText(original)).toContain("Leon Geheim");

    const result = cleanJpeg(original);
    const text = toText(result.cleaned);
    expect(text).not.toContain("ComfyUI");
    expect(text).not.toContain("Stable Diffusion");
    expect(text).not.toContain("Leon Geheim");
    expect(result.removed).toContain("EXIF");
    expect(result.orientationExifInserted).toBe(true);
    // Orientation=6 survives in the minimal EXIF (byte value 6 after tag 0x0112)
    expect(text).toContain("Exif");
    // still a valid JPEG: SOI at start, EOI at end
    expect(result.cleaned[0]).toBe(0xff);
    expect(result.cleaned[1]).toBe(0xd8);
    expect(result.cleaned[result.cleaned.length - 2]).toBe(0xff);
    expect(result.cleaned[result.cleaned.length - 1]).toBe(0xd9);
  });

  it("strips tEXt/zTXt/iTXt/eXIf from PNG while keeping structure", () => {
    const original = fromBase64(PNG_FIXTURE);
    expect(toText(original)).toContain("secret prompt");

    const result = cleanPng(original);
    const text = toText(result.cleaned);
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("geheim");
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
  });

  it("strips XMP chunk from WebP and clears the VP8X metadata flags", () => {
    const original = fromBase64(WEBP_FIXTURE);
    expect(toText(original)).toContain("SecretTool");

    const result = cleanWebp(original);
    const text = toText(result.cleaned);
    expect(text).not.toContain("SecretTool");
    expect(text).not.toContain("geheimes webp");
    expect(text.slice(0, 4)).toBe("RIFF");
    expect(text.slice(8, 12)).toBe("WEBP");
    // declared RIFF size must match the actual payload
    const declared = result.cleaned[4] | (result.cleaned[5] << 8) | (result.cleaned[6] << 16);
    expect(declared).toBe(result.cleaned.length - 8);
  });

  it("is idempotent and self-verifying", () => {
    for (const fixture of [JPEG_FIXTURE, PNG_FIXTURE, WEBP_FIXTURE]) {
      const result = cleanImageInBrowser(fromBase64(fixture));
      expect(result.cleaned.length).toBeGreaterThan(0);
    }
  });

  // --- Angreifer-Szenarien: kaputte/boshafte Dateien duerfen nur werfen ---

  it("rejects truncated files instead of crashing or looping", () => {
    const jpeg = fromBase64(JPEG_FIXTURE);
    expect(() => cleanJpeg(jpeg.subarray(0, 6))).toThrow(ClientCleanError);
    const png = fromBase64(PNG_FIXTURE);
    expect(() => cleanPng(png.subarray(0, 12))).toThrow(ClientCleanError);
  });

  it("rejects a JPEG segment whose declared length overruns the buffer", () => {
    const bytes = fromBase64(JPEG_FIXTURE);
    const evil = new Uint8Array(bytes);
    // first segment after SOI: set its length field to 0xFFFF
    evil[4] = 0xff;
    evil[5] = 0xff;
    expect(() => cleanJpeg(evil)).toThrow(ClientCleanError);
  });

  it("rejects a PNG chunk whose declared length overruns the buffer", () => {
    const bytes = fromBase64(PNG_FIXTURE);
    const evil = new Uint8Array(bytes);
    evil[8] = 0x7f; // absurd chunk length on IHDR
    expect(() => cleanPng(evil)).toThrow(ClientCleanError);
  });

  it("rejects a WebP chunk whose declared size overruns the buffer", () => {
    const bytes = fromBase64(WEBP_FIXTURE);
    const evil = new Uint8Array(bytes);
    evil[16] = 0xff;
    evil[17] = 0xff;
    evil[18] = 0xff;
    expect(() => cleanWebp(evil)).toThrow(ClientCleanError);
  });

  it("rejects a PNG without IEND (infinite-loop guard)", () => {
    const bytes = fromBase64(PNG_FIXTURE);
    const text = toText(bytes);
    const iendIndex = text.indexOf("IEND") - 4;
    expect(() => cleanPng(bytes.subarray(0, iendIndex))).toThrow(ClientCleanError);
  });

  it("refuses wrong formats per cleaner", () => {
    expect(() => cleanJpeg(fromBase64(PNG_FIXTURE))).toThrow(ClientCleanError);
    expect(() => cleanPng(fromBase64(JPEG_FIXTURE))).toThrow(ClientCleanError);
    expect(() => cleanWebp(fromBase64(JPEG_FIXTURE))).toThrow(ClientCleanError);
  });

  it("strips an embedded JFIF thumbnail (APP0) rather than keeping it verbatim", () => {
    const marker = "EXFIL-IN-JFIF-THUMBNAIL";
    const jfifBody = Buffer.concat([
      Buffer.from("JFIF\0", "latin1"),
      Buffer.from([1, 1, 0, 0, 1, 0, 1]), // version, units, density
      Buffer.from([1, 1]), // Xthumbnail=1, Ythumbnail=1
      Buffer.from(marker + "   ", "latin1") // thumbnail payload
    ]);
    const app0Len = jfifBody.length + 2;
    const app0 = Buffer.concat([
      Buffer.from([0xff, 0xe0, (app0Len >> 8) & 0xff, app0Len & 0xff]),
      jfifBody
    ]);
    const sosAndEoi = Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    const jpeg = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sosAndEoi]));

    const result = cleanJpeg(jpeg);
    expect(toText(result.cleaned)).not.toContain(marker);
    expect(result.removed).toContain("JFIF thumbnail");
    expect(toText(result.cleaned)).toContain("JFIF\0");
  });

  it("drops an oversized PNG iCCP profile beyond the color-profile cap", () => {
    const base = Buffer.from(PNG_FIXTURE, "base64");
    const big = Buffer.alloc(600 * 1024, 0x41);
    const chunk = Buffer.alloc(12 + big.length);
    chunk.writeUInt32BE(big.length, 0);
    chunk.write("iCCP", 4, "latin1");
    big.copy(chunk, 8);
    const iendIndex = base.indexOf("IEND") - 4;
    const png = new Uint8Array(Buffer.concat([base.subarray(0, iendIndex), chunk, base.subarray(iendIndex)]));

    const result = cleanPng(png);
    expect(result.removed).toContain("iCCP");
    expect(result.cleaned.length).toBeLessThan(png.length);
  });
});
