import { describe, expect, it } from "vitest";
import { cleanGif } from "@/gif-cleaner";
import { cleanMp3 } from "@/mp3-cleaner";
import { cleanFlac } from "@/flac-cleaner";
import { cleanMediaInBrowser, detectBrowserMediaKind, ClientMediaError } from "@/client-media-cleaner";

function ascii(text: string) {
  return Array.from(text, (char) => char.charCodeAt(0));
}

// --- fixtures ---------------------------------------------------------------

function buildGif(extras: number[][]) {
  // GIF89a, 1x1, no global color table, one 1x1 frame, trailer.
  const header = [...ascii("GIF89a"), 1, 0, 1, 0, 0x00, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];
  return new Uint8Array([...header, ...extras.flat(), ...frame, 0x3b]);
}

const GIF_COMMENT = [0x21, 0xfe, 6, ...ascii("secret"), 0];
const GIF_XMP = [0x21, 0xff, 11, ...ascii("XMP DataXMP"), 4, ...ascii("meta"), 0];
const GIF_NETSCAPE = [0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0];

function buildMp3(withId3v2: boolean, withId3v1: boolean, withApe = false) {
  const frames = [0xff, 0xfb, 0x90, 0x00, ...Array(60).fill(0xaa)];
  const parts: number[] = [];
  if (withId3v2) {
    const body = Array(20).fill(0x42);
    parts.push(...ascii("ID3"), 3, 0, 0, 0, 0, 0, body.length, ...body);
  }
  parts.push(...frames);
  if (withApe) {
    const item = [...ascii("x")]; // 1 byte of "items"
    const footer = [...ascii("APETAGEX"), 0xd0, 0x07, 0, 0, item.length + 32, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    parts.push(...item, ...footer);
  }
  if (withId3v1) {
    parts.push(...ascii("TAG"), ...Array(125).fill(0x20));
  }
  return new Uint8Array(parts);
}

function buildFlac(withVorbisComment: boolean, withPicture: boolean) {
  const streaminfo = Array(34).fill(0x11);
  const parts: number[] = [...ascii("fLaC")];
  const blocks: Array<{ type: number; body: number[] }> = [{ type: 0, body: streaminfo }];
  if (withVorbisComment) blocks.push({ type: 4, body: ascii("vendor+tags") });
  if (withPicture) blocks.push({ type: 6, body: Array(16).fill(0x22) });
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1 ? 0x80 : 0;
    parts.push(last | block.type, 0, 0, block.body.length, ...block.body);
  });
  parts.push(0xff, 0xf8, 0x69, 0x18); // frame-ish audio bytes
  return new Uint8Array(parts);
}

// --- tests -------------------------------------------------------------------

describe("gif cleaner", () => {
  it("drops comments and XMP but keeps the NETSCAPE loop extension", () => {
    const gif = buildGif([GIF_COMMENT, GIF_XMP, GIF_NETSCAPE]);
    const { bytes, removed } = cleanGif(gif);

    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("XMP Data");
    expect(text).toContain("NETSCAPE2.0");
    expect(removed).toEqual(expect.arrayContaining(["comment", "xmp"]));
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    // Cleaning the clean file again removes nothing.
    expect(cleanGif(bytes).removed).toEqual([]);
  });

  it("fails closed on truncated files", () => {
    const gif = buildGif([GIF_COMMENT]).slice(0, 20);
    expect(() => cleanGif(gif)).toThrow();
  });
});

describe("mp3 cleaner", () => {
  it("strips ID3v2, ID3v1 and APE tags and keeps the frames", () => {
    const mp3 = buildMp3(true, true, true);
    const { bytes, removed } = cleanMp3(mp3);

    expect(removed).toEqual(expect.arrayContaining(["id3", "ape"]));
    expect(bytes[0]).toBe(0xff);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain("APETAGEX");
    expect(text).not.toContain("TAG");
    expect(cleanMp3(bytes).removed).toEqual([]);
  });

  it("fails closed when no frame sync remains", () => {
    const junk = new Uint8Array([...Array.from("ID3").map((c) => c.charCodeAt(0)), 3, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4, 0x00, 0x01]);
    expect(() => cleanMp3(junk)).toThrow();
  });
});

describe("flac cleaner", () => {
  it("drops VORBIS_COMMENT and PICTURE, keeps STREAMINFO and audio", () => {
    const flac = buildFlac(true, true);
    const { bytes, removed } = cleanFlac(flac);

    expect(removed).toEqual(expect.arrayContaining(["vorbisComment", "flacPicture"]));
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain("vendor+tags");
    expect(text.startsWith("fLaC")).toBe(true);
    // STREAMINFO must now be the last (and only) metadata block.
    expect(bytes[4] & 0x80).toBe(0x80);
    expect(bytes[4] & 0x7f).toBe(0);
    expect(cleanFlac(bytes).removed).toEqual([]);
  });

  it("fails closed without STREAMINFO", () => {
    const noStreaminfo = new Uint8Array([...Array.from("fLaC").map((c) => c.charCodeAt(0)), 0x84, 0, 0, 2, 1, 2]);
    expect(() => cleanFlac(noStreaminfo)).toThrow();
  });
});

describe("client media cleaner", () => {
  it("detects kinds only when bytes match the extension", () => {
    expect(detectBrowserMediaKind(buildGif([]), "a.gif")).toBe("gif");
    expect(detectBrowserMediaKind(buildMp3(true, false), "a.mp3")).toBe("mp3");
    expect(detectBrowserMediaKind(buildFlac(false, false), "a.flac")).toBe("flac");
    expect(detectBrowserMediaKind(buildGif([]), "a.mp3")).toBeNull();
    expect(detectBrowserMediaKind(new Uint8Array([1, 2, 3]), "a.gif")).toBeNull();
  });

  it("wraps cleaner failures in ClientMediaError", () => {
    const truncated = buildGif([GIF_COMMENT]).slice(0, 20);
    expect(() => cleanMediaInBrowser(truncated, "a.gif")).toThrow(ClientMediaError);
  });
});
