/**
 * The TGA decoder behind livery thumbnails (profile-liveries FR5.5, FR5.10): uncompressed and RLE true-colour
 * images, both origins, refusals for what it can't read, and the thumbnail sizing helper. Fixtures are built
 * as byte arrays here, so no binary file is committed.
 */
import { describe, expect, it } from 'vitest';
import { decodeTga, fitWithin, TgaError } from '../../src/lib/tga';

function header(type: number, width: number, height: number, depth: number, descriptor = 0): number[] {
  return [
    0,
    0,
    type,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    width & 255,
    width >> 8,
    height & 255,
    height >> 8,
    depth,
    descriptor,
  ];
}

// BGR(A) pixels in file order.
const RED = [0, 0, 255];
const GREEN = [0, 255, 0];
const BLUE = [255, 0, 0];
const WHITE = [255, 255, 255];

const rgba = (img: { pixels: Uint8ClampedArray }) => [...img.pixels];

describe('decodeTga', () => {
  it('decodes an uncompressed 24-bit image stored bottom row first', () => {
    // Bottom row (red, green), then top row (blue, white).
    const bytes = new Uint8Array([...header(2, 2, 2, 24), ...RED, ...GREEN, ...BLUE, ...WHITE]);
    const img = decodeTga(bytes);
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(rgba(img)).toEqual([0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('keeps the order of a top-down image', () => {
    const bytes = new Uint8Array([...header(2, 2, 1, 24, 0x20), ...RED, ...GREEN]);
    expect(rgba(decodeTga(bytes))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('decodes a 32-bit RLE image with a repeat packet and a raw packet, keeping alpha', () => {
    // Top-down 2x2: a run of 3 half-transparent red pixels, then one raw blue pixel.
    const bytes = new Uint8Array([...header(10, 2, 2, 32, 0x28), 0x82, 0, 0, 255, 128, 0x00, 255, 0, 0, 255]);
    const img = decodeTga(bytes);
    expect(rgba(img)).toEqual([255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128, 0, 0, 255, 255]);
  });

  it('skips the image id and a colour map before the pixels', () => {
    const head = header(2, 1, 1, 24, 0x20);
    head[0] = 2; // id length
    head[1] = 1; // colour map present
    head[5] = 1; // one entry
    head[7] = 24; // of 3 bytes
    const bytes = new Uint8Array([...head, 9, 9, 7, 7, 7, ...GREEN]);
    expect(rgba(decodeTga(bytes))).toEqual([0, 255, 0, 255]);
  });

  it('refuses a colour-mapped or greyscale TGA', () => {
    expect(() => decodeTga(new Uint8Array([...header(1, 1, 1, 8), 0]))).toThrow(TgaError);
    expect(() => decodeTga(new Uint8Array([...header(3, 1, 1, 8), 0]))).toThrow(/24- or 32-bit/);
  });

  it('refuses a 16-bit image, a truncated file and a file too short for a header', () => {
    expect(() => decodeTga(new Uint8Array([...header(2, 1, 1, 16), 0, 0]))).toThrow(TgaError);
    expect(() => decodeTga(new Uint8Array([...header(2, 2, 2, 24), ...RED]))).toThrow(TgaError);
    expect(() => decodeTga(new Uint8Array([...header(10, 2, 2, 24), 0x83]))).toThrow(TgaError);
    expect(() => decodeTga(new Uint8Array([0, 0, 2]))).toThrow(TgaError);
  });

  it('refuses a zero-sized image', () => {
    expect(() => decodeTga(new Uint8Array(header(2, 0, 4, 24)))).toThrow(TgaError);
  });
});

describe('fitWithin', () => {
  it('scales a 2048 px livery to the 320 px thumbnail and the 1024 px preview', () => {
    expect(fitWithin(2048, 2048, 320)).toEqual({ width: 320, height: 320 });
    expect(fitWithin(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
  });

  it('never enlarges a small image and never reaches zero', () => {
    expect(fitWithin(200, 100, 320)).toEqual({ width: 200, height: 100 });
    expect(fitWithin(4000, 1, 320)).toEqual({ width: 320, height: 1 });
  });
});
