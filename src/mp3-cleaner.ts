// Byte-level MP3 tag removal. MP3 metadata lives in discrete tag blocks that
// wrap the audio frames: ID3v2 at the start, ID3v1/ID3v1-extended, APEv2 and
// Lyrics3v2 at the end. The frames themselves are copied verbatim — no
// re-encoding, no quality loss. Isomorphic: no Node APIs.

import { bytesStartWith, decodeLatin1 } from "./bytes";

export class Mp3CleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp3CleanError";
  }
}

export type Mp3CleanResult = {
  bytes: Uint8Array;
  removed: string[];
};

function synchsafeSize(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function stripLeadingId3v2(bytes: Uint8Array, removed: string[]) {
  let start = 0;
  while (bytesStartWith(bytes, "ID3", start)) {
    if (start + 10 > bytes.length) throw new Mp3CleanError("Truncated ID3v2 tag.");
    const flags = bytes[start + 5];
    const size = synchsafeSize(bytes, start + 6);
    const footer = flags & 0x10 ? 10 : 0;
    const end = start + 10 + size + footer;
    if (end > bytes.length) throw new Mp3CleanError("Truncated ID3v2 tag.");
    removed.push("id3");
    start = end;
  }
  return start;
}

function stripTrailingTags(bytes: Uint8Array, endExclusive: number, removed: string[]) {
  let end = endExclusive;
  for (;;) {
    // ID3v1: fixed 128 bytes ending the file, magic "TAG". The extended
    // variant adds 227 bytes ("TAG+") directly before it.
    if (end >= 128 && decodeLatin1(bytes.subarray(end - 128, end - 125)) === "TAG") {
      end -= 128;
      removed.push("id3");
      if (end >= 227 && decodeLatin1(bytes.subarray(end - 227, end - 223)) === "TAG+") {
        end -= 227;
      }
      continue;
    }

    // APEv2/v1: 32-byte footer with magic "APETAGEX"; the size field covers
    // items + footer. A header (v2) adds another 32 bytes.
    if (end >= 32 && decodeLatin1(bytes.subarray(end - 32, end - 24)) === "APETAGEX") {
      const footerStart = end - 32;
      const size =
        bytes[footerStart + 12] |
        (bytes[footerStart + 13] << 8) |
        (bytes[footerStart + 14] << 16) |
        (bytes[footerStart + 15] << 24);
      const flags = bytes[footerStart + 23];
      const headerBytes = flags & 0x80 ? 32 : 0;
      const total = size + headerBytes;
      if (total <= 0 || total > end) throw new Mp3CleanError("Corrupt APE tag.");
      end -= total;
      removed.push("ape");
      continue;
    }

    // ID3v2.4 permits a tag APPENDED at the end of the file, located by a
    // 10-byte footer whose magic is "3DI" (the header magic "ID3" reversed).
    // Without this, a [audio][ID3v2.4 header][frames][3DI footer] layout keeps
    // the entire tag — GEOB/GPS, artist, COMM, encoder — in a "clean" file.
    if (end >= 20 && decodeLatin1(bytes.subarray(end - 10, end - 7)) === "3DI") {
      const size = synchsafeSize(bytes, end - 4);
      const total = size + 20; // 10-byte header + tag data + 10-byte footer
      if (total <= 0 || total > end) throw new Mp3CleanError("Corrupt appended ID3v2 tag.");
      end -= total;
      removed.push("id3");
      continue;
    }

    // Lyrics3v2: "…LYRICS200" preceded by a 6-digit size of the block.
    if (end >= 15 && decodeLatin1(bytes.subarray(end - 9, end)) === "LYRICS200") {
      const sizeText = decodeLatin1(bytes.subarray(end - 15, end - 9));
      const size = Number.parseInt(sizeText, 10);
      if (!Number.isFinite(size) || size <= 0 || size + 15 > end) {
        throw new Mp3CleanError("Corrupt Lyrics3 tag.");
      }
      end -= size + 15;
      removed.push("lyrics");
      continue;
    }

    return end;
  }
}

export function cleanMp3(bytes: Uint8Array): Mp3CleanResult {
  const removed: string[] = [];
  const start = stripLeadingId3v2(bytes, removed);
  const end = stripTrailingTags(bytes, bytes.length, removed);

  if (end <= start) throw new Mp3CleanError("No audio data left after removing tags.");

  const cleaned = bytes.subarray(start, end);
  // Fail closed: the result must begin with an MPEG audio frame sync
  // (11 set bits). Anything else means we misparsed the file.
  if (cleaned.length < 4 || cleaned[0] !== 0xff || (cleaned[1] & 0xe0) !== 0xe0) {
    throw new Mp3CleanError("Cleaned MP3 does not start with an audio frame.");
  }

  return { bytes: cleaned, removed };
}
