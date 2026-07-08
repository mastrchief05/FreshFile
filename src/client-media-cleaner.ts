// Browser-side GIF/MP3/FLAC cleaning. Same contract as the other client
// cleaners: conservative detection, deterministic byte surgery, and a typed
// error so callers can fall back to the server path (which re-validates
// with ExifTool) whenever anything looks unusual.

import { bytesStartWith } from "./bytes";
import { cleanFlac, FlacCleanError } from "./flac-cleaner";
import { cleanGif, GifCleanError } from "./gif-cleaner";
import { cleanMp3, Mp3CleanError } from "./mp3-cleaner";

export class ClientMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMediaError";
  }
}

export type BrowserMediaKind = "gif" | "mp3" | "flac";

export type ClientMediaResult = {
  bytes: Uint8Array;
  kind: BrowserMediaKind;
  removed: string[];
};

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function detectBrowserMediaKind(bytes: Uint8Array, filename: string): BrowserMediaKind | null {
  const extension = extensionOf(filename);

  if (extension === "gif") {
    return bytesStartWith(bytes, "GIF87a") || bytesStartWith(bytes, "GIF89a") ? "gif" : null;
  }
  if (extension === "flac") {
    return bytesStartWith(bytes, "fLaC") || bytesStartWith(bytes, "ID3") ? "flac" : null;
  }
  if (extension === "mp3") {
    const hasFrameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    return bytesStartWith(bytes, "ID3") || hasFrameSync ? "mp3" : null;
  }
  return null;
}

export function cleanMediaInBrowser(bytes: Uint8Array, filename: string): ClientMediaResult {
  const kind = detectBrowserMediaKind(bytes, filename);
  if (!kind) {
    throw new ClientMediaError("Not a media file this browser cleaner can handle safely.");
  }

  try {
    if (kind === "gif") {
      const { bytes: cleaned, removed } = cleanGif(bytes);
      return { bytes: cleaned, kind, removed };
    }
    if (kind === "mp3") {
      const { bytes: cleaned, removed } = cleanMp3(bytes);
      return { bytes: cleaned, kind, removed };
    }
    const { bytes: cleaned, removed } = cleanFlac(bytes);
    return { bytes: cleaned, kind, removed };
  } catch (error) {
    if (error instanceof GifCleanError || error instanceof Mp3CleanError || error instanceof FlacCleanError) {
      throw new ClientMediaError(error.message);
    }
    throw error;
  }
}
