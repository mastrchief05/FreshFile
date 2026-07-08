// Browser-side metadata removal for JPEG, PNG, and WebP: byte-level segment
// surgery, no re-encoding, so pixels stay bit-identical. Runs entirely on the
// user's device — these files never reach the server.
//
// Safety rules: every offset is bounds-checked, unknown ancillary data is
// DROPPED (fail closed), and any structural surprise throws
// ClientCleanError — the caller then falls back to the server pipeline.

export class ClientCleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientCleanError";
  }
}

export type ClientCleanResult = {
  cleaned: Uint8Array;
  removed: string[];
  // Set when a minimal EXIF holding only the orientation tag was re-inserted
  // so rotated photos keep displaying correctly.
  orientationExifInserted?: boolean;
};

export type BrowserImageKind = "jpeg" | "png" | "webp";

export function detectBrowserImageKind(bytes: Uint8Array): BrowserImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// --- JPEG --------------------------------------------------------------------

// Color/rendering data is preserved for fidelity (matching ExifTool and every
// comparable tool). It is capped so it can't be abused as a bulk-exfil channel;
// oversized "profiles" are dropped rather than trusted.
const MAX_COLOR_PROFILE_BYTES = 512 * 1024;

// A standard JFIF APP0 header is 14 bytes; anything after is an embedded
// thumbnail (attacker-controlled) and is stripped.
function minimalJfifApp0(body: Uint8Array): Uint8Array | null {
  if (body.length < 14 || ascii(body, 0, 5) !== "JFIF\0") return null;
  const header = new Uint8Array(14);
  header.set(body.subarray(0, 14));
  header[12] = 0; // Xthumbnail
  header[13] = 0; // Ythumbnail
  const segment = new Uint8Array(4 + 14);
  segment[0] = 0xff;
  segment[1] = 0xe0;
  segment[2] = (14 + 2) >> 8;
  segment[3] = (14 + 2) & 0xff;
  segment.set(header, 4);
  return segment;
}

function readExifOrientation(segment: Uint8Array): number | null {
  // segment starts after "Exif\0\0": TIFF header + IFD0
  if (segment.length < 14) return null;
  const little = segment[0] === 0x49 && segment[1] === 0x49;
  const big = segment[0] === 0x4d && segment[1] === 0x4d;
  if (!little && !big) return null;

  const u16 = (offset: number) =>
    little ? segment[offset] | (segment[offset + 1] << 8) : (segment[offset] << 8) | segment[offset + 1];
  const u32 = (offset: number) =>
    little
      ? (segment[offset] | (segment[offset + 1] << 8) | (segment[offset + 2] << 16)) + segment[offset + 3] * 0x1000000
      : segment[offset] * 0x1000000 + ((segment[offset + 1] << 16) | (segment[offset + 2] << 8) | segment[offset + 3]);

  if (u16(2) !== 0x2a) return null;
  const ifdOffset = u32(4);
  if (ifdOffset + 2 > segment.length) return null;
  const entryCount = u16(ifdOffset);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > segment.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

// Scans the EXIF being removed for identifying tags so the UI can name what
// went away (GPS, author, device, timestamps). Reports presence only — no
// values are read. Best-effort; returns [] on any parse hiccup.
function exifIdentifyingTokens(segment: Uint8Array): string[] {
  if (segment.length < 14) return [];
  const little = segment[0] === 0x49 && segment[1] === 0x49;
  const big = segment[0] === 0x4d && segment[1] === 0x4d;
  if (!little && !big) return [];
  const u16 = (o: number) => (little ? segment[o] | (segment[o + 1] << 8) : (segment[o] << 8) | segment[o + 1]);
  const u32 = (o: number) =>
    little
      ? (segment[o] | (segment[o + 1] << 8) | (segment[o + 2] << 16)) + segment[o + 3] * 0x1000000
      : segment[o] * 0x1000000 + ((segment[o + 1] << 16) | (segment[o + 2] << 8) | segment[o + 3]);

  if (u16(2) !== 0x2a) return [];
  const ifdOffset = u32(4);
  if (ifdOffset + 2 > segment.length) return [];
  const count = u16(ifdOffset);
  const tokens = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > segment.length) break;
    const tag = u16(entry);
    if (tag === 0x8825) tokens.add("GPS"); // GPS IFD pointer
    else if (tag === 0x013b || tag === 0x8298) tokens.add("Author"); // Artist / Copyright
    else if (tag === 0x0131 || tag === 0x010f || tag === 0x0110) tokens.add("Software"); // Software / Make / Model
    else if (tag === 0x0132) tokens.add("DateTime");
  }
  return [...tokens];
}

function minimalExifSegment(orientation: number): Uint8Array {
  // "Exif\0\0" + big-endian TIFF with a single IFD0 entry: Orientation.
  const payload = new Uint8Array(6 + 8 + 2 + 12 + 4);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // Exif\0\0
  payload.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 6); // MM, 42, IFD@8
  const ifd = 6 + 8;
  payload[ifd] = 0x00;
  payload[ifd + 1] = 0x01; // 1 entry
  payload.set([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00], ifd + 2);
  // next IFD offset = 0 (already zero-initialized)
  return payload;
}

export function cleanJpeg(bytes: Uint8Array): ClientCleanResult {
  if (detectBrowserImageKind(bytes) !== "jpeg") throw new ClientCleanError("Not a JPEG.");

  const parts: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  const removed: string[] = [];
  let orientation: number | null = null;
  let offset = 2;

  for (;;) {
    if (offset + 4 > bytes.length) throw new ClientCleanError("Truncated JPEG.");
    if (bytes[offset] !== 0xff) throw new ClientCleanError("Corrupt JPEG marker stream.");
    let marker = bytes[offset + 1];
    // skip fill bytes
    while (marker === 0xff) {
      offset += 1;
      if (offset + 4 > bytes.length) throw new ClientCleanError("Truncated JPEG.");
      marker = bytes[offset + 1];
    }

    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      // SOI/RSTn have no length — should not appear here before SOS
      throw new ClientCleanError("Unexpected JPEG marker.");
    }

    if (marker === 0xda) {
      // SOS: entropy-coded data follows — copy the rest verbatim (incl. EOI).
      parts.push(bytes.subarray(offset));
      break;
    }

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) throw new ClientCleanError("Corrupt JPEG segment length.");
    const segment = bytes.subarray(offset, offset + 2 + length);
    const body = bytes.subarray(offset + 4, offset + 2 + length);

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (!isApp && !isComment) {
      parts.push(segment); // structural: DQT, SOF, DHT, DRI, ...
    } else if (marker === 0xe0 && ascii(body, 0, 5) === "JFIF\0") {
      // Keep only the standard JFIF header; strip any embedded thumbnail.
      const minimal = minimalJfifApp0(body);
      if (minimal) {
        parts.push(minimal);
        if (body.length > 14) removed.push("JFIF thumbnail");
      } else {
        removed.push("APP0");
      }
    } else if (marker === 0xe2 && ascii(body, 0, 12) === "ICC_PROFILE\0" && segment.length <= MAX_COLOR_PROFILE_BYTES) {
      parts.push(segment); // color profile within the size cap
    } else if (marker === 0xee && ascii(body, 0, 5) === "Adobe") {
      parts.push(segment); // 12-byte Adobe color-transform marker
    } else if (marker === 0xe1 && ascii(body, 0, 6) === "Exif\0\0") {
      orientation = readExifOrientation(body.subarray(6));
      removed.push("EXIF", ...exifIdentifyingTokens(body.subarray(6)));
    } else if (isComment) {
      removed.push("Comment");
    } else if (marker === 0xe1) {
      removed.push("XMP");
    } else if (marker === 0xe0) {
      removed.push("JFXX/APP0"); // JFXX thumbnail extension or unknown APP0
    } else {
      removed.push(`APP${marker - 0xe0}`);
    }

    offset += 2 + length;
  }

  if (orientation && orientation > 1) {
    // Re-insert a minimal EXIF holding only the orientation so rotation
    // display stays correct; drop it from the removed list semantics.
    const exif = minimalExifSegment(orientation);
    const header = new Uint8Array(4);
    header[0] = 0xff;
    header[1] = 0xe1;
    header[2] = (exif.length + 2) >> 8;
    header[3] = (exif.length + 2) & 0xff;
    parts.splice(1, 0, header, exif);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const cleaned = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    cleaned.set(part, cursor);
    cursor += part.length;
  }
  return { cleaned, removed, orientationExifInserted: Boolean(orientation && orientation > 1) };
}

// --- PNG ---------------------------------------------------------------------

// Whitelist: structure, pixels, transparency, color reproduction, animation.
// All kept chunks except iCCP are small and fixed-shape; iCCP carries a
// compressed profile whose size is capped so it can't be an exfil channel.
// Everything else (tEXt/zTXt/iTXt/eXIf/tIME/private chunks) is metadata.
const PNG_KEEP_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "pHYs",
  "bKGD",
  "acTL",
  "fcTL",
  "fdAT"
]);

export function cleanPng(bytes: Uint8Array): ClientCleanResult {
  if (detectBrowserImageKind(bytes) !== "png") throw new ClientCleanError("Not a PNG.");

  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed: string[] = [];
  let offset = 8;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new ClientCleanError("Truncated PNG chunk header.");
    const length =
      bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    if (length > 0x7fffffff || offset + 12 + length > bytes.length) {
      throw new ClientCleanError("Corrupt PNG chunk length.");
    }
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ClientCleanError("Corrupt PNG chunk type.");
    const chunk = bytes.subarray(offset, offset + 12 + length);

    if (type === "iCCP" && length <= MAX_COLOR_PROFILE_BYTES) {
      parts.push(chunk); // embedded color profile within the size cap
    } else if (PNG_KEEP_CHUNKS.has(type)) {
      parts.push(chunk);
    } else {
      removed.push(type);
    }

    offset += 12 + length;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }

  if (!sawEnd) throw new ClientCleanError("PNG has no IEND chunk.");

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const cleaned = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    cleaned.set(part, cursor);
    cursor += part.length;
  }
  return { cleaned, removed };
}

// --- WebP --------------------------------------------------------------------

// ICCP (color profile) is kept but size-capped; the rest are pixel/structure.
const WEBP_KEEP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

export function cleanWebp(bytes: Uint8Array): ClientCleanResult {
  if (detectBrowserImageKind(bytes) !== "webp") throw new ClientCleanError("Not a WebP.");

  const declaredSize = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] * 0x1000000);
  if (declaredSize + 8 > bytes.length + 8) {
    // tolerate trailing bytes but not a size that overruns the buffer
    if (declaredSize + 8 > bytes.length) throw new ClientCleanError("Corrupt WebP size.");
  }

  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  let offset = 12;

  while (offset + 8 <= Math.min(bytes.length, declaredSize + 8)) {
    const fourcc = ascii(bytes, offset, 4);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] * 0x1000000);
    const padded = size + (size % 2);
    if (offset + 8 + padded > bytes.length) throw new ClientCleanError("Corrupt WebP chunk size.");
    const chunk = bytes.subarray(offset, offset + 8 + padded);

    if (fourcc === "ICCP" && size <= MAX_COLOR_PROFILE_BYTES) {
      parts.push(chunk); // color profile within the size cap
    } else if (WEBP_KEEP_CHUNKS.has(fourcc)) {
      if (fourcc === "VP8X") {
        // copy so the metadata flag bits can be cleared
        const copy = new Uint8Array(chunk);
        copy[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
        parts.push(copy);
      } else {
        parts.push(chunk);
      }
    } else {
      removed.push(fourcc.trim());
    }

    offset += 8 + padded;
  }

  const payload = parts.reduce((sum, part) => sum + part.length, 0);
  const cleaned = new Uint8Array(12 + payload);
  cleaned.set(bytes.subarray(0, 12), 0);
  const riffSize = payload + 4;
  cleaned[4] = riffSize & 0xff;
  cleaned[5] = (riffSize >> 8) & 0xff;
  cleaned[6] = (riffSize >> 16) & 0xff;
  cleaned[7] = (riffSize >>> 24) & 0xff;
  let cursor = 12;
  for (const part of parts) {
    cleaned.set(part, cursor);
    cursor += part.length;
  }
  return { cleaned, removed };
}

// --- Dispatch ------------------------------------------------------------------

export function cleanImageInBrowser(bytes: Uint8Array): ClientCleanResult & { kind: BrowserImageKind } {
  const kind = detectBrowserImageKind(bytes);
  if (!kind) throw new ClientCleanError("Not a browser-cleanable image.");

  const clean = kind === "jpeg" ? cleanJpeg : kind === "png" ? cleanPng : cleanWebp;
  const result = clean(bytes);

  // Self-verification: cleaning the output again must find nothing left. The
  // only tolerated leftover is the minimal orientation EXIF a JPEG clean may
  // have re-inserted on purpose.
  const verify = clean(result.cleaned);
  const unexpected = verify.removed.filter((name) => !(result.orientationExifInserted && name === "EXIF"));
  if (unexpected.length > 0) {
    throw new ClientCleanError("Verification failed after cleaning.");
  }

  return { ...result, kind };
}
