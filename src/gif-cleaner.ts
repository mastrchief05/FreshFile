// Byte-level GIF metadata removal. GIF stores metadata in discrete extension
// blocks, so cleaning is pure block-walking: comment extensions and non-
// animation application extensions (XMP, ICC) are dropped, everything the
// renderer needs — frames, palettes, graphic controls, NETSCAPE looping —
// is copied verbatim. Isomorphic: no Node APIs.

import { bytesStartWith, concatBytes, decodeLatin1 } from "./bytes";

export class GifCleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifCleanError";
  }
}

export type GifCleanResult = {
  bytes: Uint8Array;
  removed: string[];
};

const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2c;
const TRAILER = 0x3b;
const LABEL_COMMENT = 0xfe;
const LABEL_APPLICATION = 0xff;

// Application identifiers (11 bytes) that control animation playback and must
// survive; every other application extension is metadata (XMP, ICC, …).
const KEPT_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

function subBlocksEnd(bytes: Uint8Array, offset: number) {
  // A sub-block chain is (length byte, data…)* terminated by a 0x00 length.
  let cursor = offset;
  for (;;) {
    if (cursor >= bytes.length) throw new GifCleanError("Truncated GIF sub-blocks.");
    const length = bytes[cursor];
    cursor += 1 + length;
    if (length === 0) return cursor;
  }
}

export function cleanGif(bytes: Uint8Array): GifCleanResult {
  if (!bytesStartWith(bytes, "GIF87a") && !bytesStartWith(bytes, "GIF89a")) {
    throw new GifCleanError("Not a GIF file.");
  }
  if (bytes.length < 13) throw new GifCleanError("Truncated GIF header.");

  const kept: Uint8Array[] = [];
  const removed: string[] = [];

  // Header (6) + Logical Screen Descriptor (7) + optional Global Color Table.
  const packed = bytes[10];
  const globalTableBytes = packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  let cursor = 13 + globalTableBytes;
  if (cursor > bytes.length) throw new GifCleanError("Truncated GIF color table.");
  kept.push(bytes.subarray(0, cursor));

  while (cursor < bytes.length) {
    const marker = bytes[cursor];

    if (marker === TRAILER) {
      kept.push(bytes.subarray(cursor, cursor + 1));
      cursor += 1;
      break;
    }

    if (marker === EXTENSION_INTRODUCER) {
      if (cursor + 2 > bytes.length) throw new GifCleanError("Truncated GIF extension.");
      const label = bytes[cursor + 1];
      const end = subBlocksEnd(bytes, cursor + 2);

      if (label === LABEL_COMMENT) {
        removed.push("comment");
      } else if (label === LABEL_APPLICATION) {
        const idLength = bytes[cursor + 2];
        const appId = decodeLatin1(bytes.subarray(cursor + 3, cursor + 3 + Math.min(idLength, 11)));
        if (KEPT_APPLICATIONS.has(appId)) {
          kept.push(bytes.subarray(cursor, end));
        } else {
          removed.push(appId.includes("XMP") ? "xmp" : `app:${appId}`);
        }
      } else {
        // Graphic control, plain text, and unknown labels stay: they affect
        // rendering, not privacy.
        kept.push(bytes.subarray(cursor, end));
      }
      cursor = end;
      continue;
    }

    if (marker === IMAGE_SEPARATOR) {
      if (cursor + 10 > bytes.length) throw new GifCleanError("Truncated GIF image descriptor.");
      const localPacked = bytes[cursor + 9];
      const localTableBytes = localPacked & 0x80 ? 3 * (1 << ((localPacked & 0x07) + 1)) : 0;
      const dataStart = cursor + 10 + localTableBytes + 1; // + LZW minimum code size byte
      if (dataStart > bytes.length) throw new GifCleanError("Truncated GIF image data.");
      const end = subBlocksEnd(bytes, dataStart);
      kept.push(bytes.subarray(cursor, end));
      cursor = end;
      continue;
    }

    throw new GifCleanError("Unknown GIF block marker.");
  }

  const cleaned = concatBytes(kept);
  if (cleaned.length === 0 || cleaned[cleaned.length - 1] !== TRAILER) {
    throw new GifCleanError("GIF cleaning produced an invalid file.");
  }
  return { bytes: cleaned, removed };
}
