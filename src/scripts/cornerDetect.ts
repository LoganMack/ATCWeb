// "Detect corners from image" for the layout map editor (layoutMapEditor.ts).
//
// Layout maps carry their corner numbers as small white glyphs floating beside the track line. This finds
// those glyph groups (connected components, merged by proximity), and reads each group with OCR (tesseract.js,
// loaded on demand from a CDN — nothing is bundled or downloaded until the admin presses the button).
// Everything below `findNumberClusters` is pure, so it can run anywhere; only `readClusters` touches the DOM/OCR.

export interface Cluster {
  /** Pixel bounding box in the square detection canvas. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DetectedCorner {
  /** The number read from the image ("7", "11a"), or null when OCR couldn't read it. */
  label: string | null;
  /** Centre of the glyph group, as a percentage of the map (0-100). */
  x: number;
  y: number;
  /** True when the reading is doubtful (empty/invalid, or the wrong number of characters for the glyph group's width). */
  uncertain: boolean;
}

/** Side of the square canvas the map is drawn on for detection. */
export const DETECT_SIDE = 1000;
const LABEL_RE = /^\d{1,2}[a-d]?$/;
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

/** Binary mask (1 = white-ish foreground) from RGBA pixels drawn on black; flips itself if the image turned out dark-on-light. */
export function foregroundMask(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  let on = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (lum > 128) {
      mask[i] = 1;
      on++;
    }
  }
  if (on > mask.length / 2) for (let i = 0; i < mask.length; i++) mask[i] ^= 1;
  return mask;
}

interface Comp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

function components(mask: Uint8Array, width: number, height: number): Comp[] {
  const seen = new Uint8Array(mask.length);
  const out: Comp[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = width, y0 = height, x1 = 0, y1 = 0, area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area });
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Groups of glyph-sized shapes that could be a corner number: right height, at most three characters wide. */
export function findNumberClusters(mask: Uint8Array, width: number, height: number): Cluster[] {
  const comps = components(mask, width, height);
  // Glyph height = the typical height of the many small shapes (the track line and any big outline are far bigger).
  const sizes = comps.filter((c) => c.area >= 12 && c.y1 - c.y0 >= 6 && c.y1 - c.y0 <= width * 0.06 && c.x1 - c.x0 <= width * 0.08);
  if (sizes.length < 2) return [];
  const glyphH = median(sizes.map((c) => c.y1 - c.y0));
  const glyphs = sizes.filter((c) => c.y1 - c.y0 >= glyphH * 0.35 && c.y1 - c.y0 <= glyphH * 1.7);

  // Merge neighbouring glyphs into groups ("1" + "1" + "a" → "11a"). Words merge too; OCR throws those away.
  const gx = glyphH * 0.55;
  const gy = glyphH * 0.35;
  let boxes: Cluster[] = glyphs.map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }));
  let merged = true;
  while (merged) {
    merged = false;
    const next: Cluster[] = [];
    while (boxes.length) {
      let b = boxes.pop()!;
      for (let i = 0; i < boxes.length; ) {
        const c = boxes[i];
        if (b.x0 - gx <= c.x1 && c.x0 - gx <= b.x1 && b.y0 - gy <= c.y1 && c.y0 - gy <= b.y1) {
          b = { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) };
          boxes.splice(i, 1);
          merged = true;
        } else i++;
      }
      next.push(b);
    }
    boxes = next;
  }
  return boxes
    .filter((b) => b.x1 - b.x0 <= glyphH * 2.6 && b.y1 - b.y0 <= glyphH * 1.7 && b.y1 - b.y0 >= glyphH * 0.7)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** How many characters a glyph group of this size should hold (digits/letters are ~0.72 × the height wide). */
export function expectedChars(c: Cluster): number {
  return Math.max(1, Math.round((c.x1 - c.x0) / ((c.y1 - c.y0) * 0.72)));
}

/** OCR-ready canvas for one group: the tight crop at 3×, glyphs thickened 2×2, black on white with a wide margin. */
function cropForOcr(mask: Uint8Array, width: number, c: Cluster): HTMLCanvasElement {
  const pad = 3;
  const sw = c.x1 - c.x0 + pad * 2;
  const sh = c.y1 - c.y0 + pad * 2;
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d')!;
  const sd = sctx.createImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const mx = c.x0 - pad + x;
      const my = c.y0 - pad + y;
      const v = mx >= 0 && my >= 0 && mx < width && mask[my * width + mx] ? 255 : 0;
      const o = (y * sw + x) * 4;
      sd.data[o] = sd.data[o + 1] = sd.data[o + 2] = v;
      sd.data[o + 3] = 255;
    }
  }
  sctx.putImageData(sd, 0, 0);
  const scale = 3;
  const margin = 30;
  const big = document.createElement('canvas');
  big.width = sw * scale + margin * 2;
  big.height = sh * scale + margin * 2;
  const bctx = big.getContext('2d', { willReadFrequently: true })!;
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, big.width, big.height);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, margin, margin, sw * scale, sh * scale);
  const id = bctx.getImageData(0, 0, big.width, big.height);
  const src = new Uint8ClampedArray(id.data);
  const w = big.width;
  const h = big.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 2×2 max filter (thickens the white glyph strokes), then invert to black-on-white.
      let m = src[(y * w + x) * 4];
      if (x + 1 < w) m = Math.max(m, src[(y * w + x + 1) * 4]);
      if (y + 1 < h) m = Math.max(m, src[((y + 1) * w + x) * 4]);
      if (x + 1 < w && y + 1 < h) m = Math.max(m, src[((y + 1) * w + x + 1) * 4]);
      const o = (y * w + x) * 4;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = 255 - m;
      id.data[o + 3] = 255;
    }
  }
  bctx.putImageData(id, 0, 0);
  return big;
}

interface OcrWorker {
  recognize: (img: HTMLCanvasElement) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
}

/** Reads every group with OCR. Returns the groups that are numbers ("7", "11a"), plus doubtful ones flagged `uncertain`. */
export async function readClusters(
  mask: Uint8Array,
  width: number,
  height: number,
  clusters: Cluster[],
  onProgress?: (done: number, total: number) => void
): Promise<DetectedCorner[]> {
  type TesseractApi = {
    createWorker: (lang: string, oem: number, opts: Record<string, unknown>, config: Record<string, unknown>) => Promise<OcrWorker & { setParameters: (p: Record<string, string>) => Promise<unknown> }>;
  };
  // The ESM build only has a default export (the whole library); fall back to named in case that changes.
  const imported = (await import(/* @vite-ignore */ TESSERACT_URL)) as TesseractApi & { default?: TesseractApi };
  const mod: TesseractApi = imported.default?.createWorker ? imported.default : imported;
  const worker = await mod.createWorker('eng', 1, { logger: () => undefined }, { load_system_dawg: '0', load_freq_dawg: '0' });
  try {
    await worker.setParameters({ tessedit_char_whitelist: '0123456789abcd', tessedit_pageseg_mode: '7' });
    const out: DetectedCorner[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const text = (await worker.recognize(cropForOcr(mask, width, c))).data.text.replace(/\s+/g, '');
      onProgress?.(i + 1, clusters.length);
      const valid = LABEL_RE.test(text);
      // Words ("Kink", "Carousel") read as nothing or as stray characters: a group is only kept when it
      // looks like a number, or when it's number-sized and OCR gave something partial (flagged for review).
      if (!valid && text === '' && c.x1 - c.x0 > (c.y1 - c.y0) * 1.5) continue;
      out.push({
        label: valid ? text : null,
        x: Math.round((((c.x0 + c.x1) / 2) / width) * 10000) / 100,
        y: Math.round((((c.y0 + c.y1) / 2) / height) * 10000) / 100,
        uncertain: !valid || text.length !== expectedChars(c),
      });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}
