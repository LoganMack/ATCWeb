/**
 * The poll editor's image shrinking decisions (src/scripts/pollImageResize.ts; polls BR4.1): the size that
 * fits 1600 px, which files are sent as they are, and the new file name. The canvas part needs a browser.
 */
import { describe, expect, it } from 'vitest';
import {
  POLL_IMAGE_KEEP_BYTES,
  POLL_IMAGE_MAX_SIDE,
  POLL_PNG_KEEP_BYTES,
  fitWithin,
  keepOriginal,
  resizedName,
} from '../../src/scripts/pollImageResize';

describe('fitWithin', () => {
  it('scales the longest side down to 1600 px and keeps the shape', () => {
    expect(POLL_IMAGE_MAX_SIDE).toBe(1600);
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 5000)).toEqual({ width: 320, height: 1600 });
  });

  it('never enlarges, and never goes below 1 px', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(100000, 10)).toEqual({ width: 1600, height: 1 });
  });
});

describe('keepOriginal', () => {
  it('keeps small PNGs and small JPEG or WebP files within the side limit', () => {
    expect(keepOriginal('image/png', POLL_PNG_KEEP_BYTES, 1600, 900)).toBe(true);
    expect(keepOriginal('image/jpeg', POLL_IMAGE_KEEP_BYTES, 1200, 800)).toBe(true);
    expect(keepOriginal('image/webp', 1000, 10, 10)).toBe(true);
  });

  it('re-encodes large PNGs, large files and anything over 1600 px', () => {
    expect(keepOriginal('image/png', POLL_PNG_KEEP_BYTES + 1, 800, 600)).toBe(false);
    expect(keepOriginal('image/jpeg', POLL_IMAGE_KEEP_BYTES + 1, 800, 600)).toBe(false);
    expect(keepOriginal('image/webp', 1000, 1601, 10)).toBe(false);
  });
});

describe('resizedName', () => {
  it('swaps the extension for the new type', () => {
    expect(resizedName('spa.png', 'image/webp')).toBe('spa.webp');
    expect(resizedName('monza.final.jpeg', 'image/jpeg')).toBe('monza.final.jpg');
    expect(resizedName('.png', 'image/webp')).toBe('image.webp');
  });
});
