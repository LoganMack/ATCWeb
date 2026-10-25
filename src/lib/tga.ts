/**
 * A small Truevision TGA decoder for livery thumbnails (profile-liveries FR5.5, FR5.10). Pure, so it runs in the
 * browser (src/scripts/liveries.ts) and in tests. It reads what iRacing paint tools export: true-colour images,
 * uncompressed (type 2) or run-length encoded (type 10), 24 or 32 bits per pixel, either origin.
 */

export class TgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TgaError';
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, top row first. */
  pixels: Uint8ClampedArray;
}

const HEADER_BYTES = 18;
/** iRacing paints are 2048 px; anything far larger is not a livery and would exhaust memory. */
export const TGA_MAX_SIDE = 8192;

export const TGA_UNSUPPORTED_MESSAGE =
  "This .tga can't be read. Save it as a 24- or 32-bit true-colour TGA (uncompressed or RLE) and try again.";

interface TgaHeader {
  width: number;
  height: number;
  bytesPerPixel: 3 | 4;
  rle: boolean;
  topDown: boolean;
  rightToLeft: boolean;
  dataStart: number;
}

function readHeader(bytes: Uint8Array): TgaHeader {
  if (bytes.length < HEADER_BYTES) throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  if (imageType !== 2 && imageType !== 10) throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
  const depth = bytes[16];
  if (depth !== 24 && depth !== 32) throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  if (width === 0 || height === 0 || width > TGA_MAX_SIDE || height > TGA_MAX_SIDE) {
    throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
  }
  // A true-colour image may still carry a colour map, which is skipped.
  const colorMapBytes = colorMapType === 1 ? view.getUint16(5, true) * Math.ceil(bytes[7] / 8) : 0;
  const descriptor = bytes[17];
  return {
    width,
    height,
    bytesPerPixel: depth === 32 ? 4 : 3,
    rle: imageType === 10,
    topDown: (descriptor & 0x20) !== 0,
    rightToLeft: (descriptor & 0x10) !== 0,
    dataStart: HEADER_BYTES + idLength + colorMapBytes,
  };
}

/** The pixels in file order as BGR(A) runs expanded to RGBA. Throws when the data ends early. */
function readPixels(bytes: Uint8Array, h: TgaHeader): Uint8ClampedArray {
  const count = h.width * h.height;
  const out = new Uint8ClampedArray(count * 4);
  const bpp = h.bytesPerPixel;
  let src = h.dataStart;
  let px = 0;
  const copy = (from: number) => {
    const o = px * 4;
    out[o] = bytes[from + 2];
    out[o + 1] = bytes[from + 1];
    out[o + 2] = bytes[from];
    out[o + 3] = bpp === 4 ? bytes[from + 3] : 255;
    px++;
  };
  while (px < count) {
    let run = count - px;
    let repeat = false;
    if (h.rle) {
      if (src >= bytes.length) throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
      const packet = bytes[src++];
      run = Math.min((packet & 0x7f) + 1, count - px);
      repeat = (packet & 0x80) !== 0;
    }
    const needed = repeat ? bpp : run * bpp;
    if (src + needed > bytes.length) throw new TgaError(TGA_UNSUPPORTED_MESSAGE);
    for (let i = 0; i < run; i++) copy(repeat ? src : src + i * bpp);
    src += needed;
  }
  return out;
}

/** Reorders file-order pixels to top row first, left to right. */
function orient(pixels: Uint8ClampedArray, h: TgaHeader): Uint8ClampedArray {
  if (h.topDown && !h.rightToLeft) return pixels;
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < h.height; y++) {
    const srcRow = h.topDown ? y : h.height - 1 - y;
    for (let x = 0; x < h.width; x++) {
      const srcX = h.rightToLeft ? h.width - 1 - x : x;
      const s = (srcRow * h.width + srcX) * 4;
      const d = (y * h.width + x) * 4;
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = pixels[s + 3];
    }
  }
  return out;
}

/** Decodes a TGA file's bytes; throws a TgaError with a readable message for anything it can't read. */
export function decodeTga(bytes: Uint8Array): DecodedImage {
  const header = readHeader(bytes);
  const pixels = orient(readPixels(bytes, header), header);
  return { width: header.width, height: header.height, pixels };
}

/** The size that fits inside `max` × `max` keeping the aspect ratio; never larger than the original. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
