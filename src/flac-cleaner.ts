// Byte-level FLAC metadata removal. FLAC prefixes the audio frames with a
// chain of typed metadata blocks; VORBIS_COMMENT (tags + vendor string),
// PICTURE (cover art), APPLICATION and PADDING are dropped, STREAMINFO,
// SEEKTABLE and CUESHEET (decoding/playback data) survive. Audio frames are
// copied verbatim. Isomorphic: no Node APIs.

import { bytesStartWith, concatBytes } from "./bytes";

export class FlacCleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlacCleanError";
  }
}

export type FlacCleanResult = {
  bytes: Uint8Array;
  removed: string[];
};

const BLOCK_STREAMINFO = 0;
const BLOCK_PADDING = 1;
const BLOCK_APPLICATION = 2;
const BLOCK_SEEKTABLE = 3;
const BLOCK_VORBIS_COMMENT = 4;
const BLOCK_CUESHEET = 5;
const BLOCK_PICTURE = 6;

const KEPT_BLOCK_TYPES = new Set([BLOCK_STREAMINFO, BLOCK_SEEKTABLE, BLOCK_CUESHEET]);

export function cleanFlac(bytes: Uint8Array): FlacCleanResult {
  const removed: string[] = [];

  // Some taggers wrap FLAC files in an ID3v2 tag; peel it off first.
  const offset = id3PrefixLength(bytes);
  if (offset > 0) removed.push("id3");

  if (!bytesStartWith(bytes, "fLaC", offset)) {
    throw new FlacCleanError("Not a FLAC file.");
  }

  type Block = { type: number; body: Uint8Array };
  const keptBlocks: Block[] = [];
  let cursor = offset + 4;
  let last = false;

  while (!last) {
    if (cursor + 4 > bytes.length) throw new FlacCleanError("Truncated FLAC metadata.");
    const header = bytes[cursor];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    const bodyEnd = cursor + 4 + length;
    if (bodyEnd > bytes.length) throw new FlacCleanError("Truncated FLAC metadata block.");

    if (KEPT_BLOCK_TYPES.has(type)) {
      keptBlocks.push({ type, body: bytes.subarray(cursor + 4, bodyEnd) });
    } else if (type === BLOCK_VORBIS_COMMENT) {
      removed.push("vorbisComment");
    } else if (type === BLOCK_PICTURE) {
      removed.push("flacPicture");
    } else if (type === BLOCK_APPLICATION) {
      removed.push("application");
    } else if (type !== BLOCK_PADDING) {
      // Unknown block types could be anything, including future decoding
      // requirements — fail closed instead of guessing.
      throw new FlacCleanError("Unknown FLAC metadata block.");
    }

    cursor = bodyEnd;
  }

  if (keptBlocks.length === 0 || keptBlocks[0].type !== BLOCK_STREAMINFO) {
    throw new FlacCleanError("FLAC file has no STREAMINFO block.");
  }

  const parts: Uint8Array[] = [new TextEncoder().encode("fLaC")];
  keptBlocks.forEach((block, index) => {
    const header = new Uint8Array(4);
    header[0] = (index === keptBlocks.length - 1 ? 0x80 : 0) | block.type;
    header[1] = (block.body.length >> 16) & 0xff;
    header[2] = (block.body.length >> 8) & 0xff;
    header[3] = block.body.length & 0xff;
    parts.push(header, block.body);
  });
  parts.push(bytes.subarray(cursor));

  return { bytes: concatBytes(parts), removed };
}

// Length of a leading ID3v2 tag (0 when absent or truncated).
function id3PrefixLength(bytes: Uint8Array): number {
  if (!bytesStartWith(bytes, "ID3") || bytes.length < 10) return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  const end = 10 + size + footer;
  return end <= bytes.length ? end : 0;
}
