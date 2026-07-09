// Byte helpers shared by the isomorphic cleaners. Everything in here must run
// in both Node and the browser: plain Uint8Array, no node:* imports.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");
const latin1Decoder = new TextDecoder("latin1");

export function encodeUtf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function decodeLatin1(bytes: Uint8Array): string {
  return latin1Decoder.decode(bytes);
}

// TextEncoder only produces UTF-8; latin1 is a 1:1 code-point → byte mapping.
export function encodeLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function writeU16LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeU32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

// Compact synchronous SHA-256 (FIPS 180-4). Web Crypto's subtle.digest is
// async and unavailable in some non-secure contexts; the engine's cleaners
// are synchronous, so hashing must be too.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2
];

export function sha256Hex(input: Uint8Array): string {
  const length = input.length;
  const bitLength = length * 8;
  const paddedLength = ((length + 8) >> 6 << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[length] = 0x80;
  writeU32BE(padded, paddedLength - 8, Math.floor(bitLength / 0x100000000));
  writeU32BE(padded, paddedLength - 4, bitLength >>> 0);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);

  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] =
        (padded[block + t * 4] << 24) |
        (padded[block + t * 4 + 1] << 16) |
        (padded[block + t * 4 + 2] << 8) |
        padded[block + t * 4 + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  return h.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotr(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function writeU32BE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function bytesStartWith(bytes: Uint8Array, prefix: number[] | string, offset = 0): boolean {
  if (typeof prefix === "string") {
    if (offset + prefix.length > bytes.length) return false;
    for (let index = 0; index < prefix.length; index += 1) {
      if (bytes[offset + index] !== prefix.charCodeAt(index)) return false;
    }
    return true;
  }
  if (offset + prefix.length > bytes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}
