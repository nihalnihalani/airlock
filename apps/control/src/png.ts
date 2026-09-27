/**
 * Minimal PNG helpers: a structural check (signature + IHDR with a valid CRC and sane dimensions)
 * used by upload sniffing, screenshot intake and the completion checks, and a tiny encoder for
 * solid or computed RGB images (the vision probe and tests). Nothing here decodes pixel data from
 * untrusted input; the check reads only the first 33 bytes.
 */
import { deflateSync } from "node:zlib";
import { crc32 } from "./artifacts/index.ts";

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_MAX_DIMENSION = 8192;

export type PngCheck = { ok: true; width: number; height: number } | { ok: false; reason: string };

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength) return false;
  for (let i = 0; i < PNG_SIGNATURE.byteLength; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** Signature, then an IHDR chunk of length 13 with a valid CRC and 1 ≤ width, height ≤ 8192. */
export function inspectPng(bytes: Uint8Array): PngCheck {
  if (!hasPngSignature(bytes)) return { ok: false, reason: "missing PNG signature" };
  if (bytes.byteLength < 33) return { ok: false, reason: "truncated before the IHDR chunk" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8);
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== "IHDR" || length !== 13) return { ok: false, reason: "first chunk is not a 13-byte IHDR" };
  const crc = view.getUint32(29);
  if (crc32(bytes.subarray(12, 29)) !== crc) return { ok: false, reason: "IHDR CRC mismatch" };
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION)
    return { ok: false, reason: `dimensions ${width}x${height} outside 1..${PNG_MAX_DIMENSION}` };
  return { ok: true, width, height };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

/** 8-bit RGB PNG. `pixel` is either one colour for the whole image or a function of (x, y). */
export function encodePng(width: number, height: number, pixel: [number, number, number] | ((x: number, y: number) => [number, number, number])): Uint8Array {
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error("encodePng: dimensions out of range");
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = typeof pixel === "function" ? pixel(x, y) : pixel;
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}
