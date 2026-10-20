/**
 * Contrast backing for primary track logos. Any <img data-contrast-logo> is
 * sampled once it loads: if its visible artwork is mostly very dark or very
 * light, it gets `data-tone="dark"` / `data-tone="light"` so global.css can
 * give it a contrasting plate when it would otherwise vanish into the
 * current theme's background (dark logo on the dark theme, light logo on
 * the light theme). Colourful logos, and images that already fill their
 * whole box with an opaque background (JPEGs), get no tone and no plate.
 *
 * Images are same-origin (/cdn-cgi/image/...), so the canvas stays readable.
 * Anything that taints the canvas just gets no plate. Results are cached per
 * src. A capture-phase `load` listener on the document covers images that
 * arrive late (fragments are injected after the shell paints); the sweep on
 * page-load covers images that finished loading before this ran.
 */
const SAMPLE = 32;
const cache = new Map<string, string>();

function toneFor(img: HTMLImageElement): string {
  const src = img.currentSrc || img.src;
  const hit = cache.get(src);
  if (hit !== undefined) return hit;

  let tone = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

      // An opaque rectangle (all four corners solid) is its own background.
      const corner = (x: number, y: number) => data[(y * SAMPLE + x) * 4 + 3]!;
      const opaqueBox = [
        corner(0, 0),
        corner(SAMPLE - 1, 0),
        corner(0, SAMPLE - 1),
        corner(SAMPLE - 1, SAMPLE - 1),
      ].every((a) => a > 200);

      if (!opaqueBox) {
        let visible = 0;
        let dark = 0;
        let light = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3]! < 40) continue;
          visible++;
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          if (Math.max(r, g, b) < 90) dark++;
          else if (Math.min(r, g, b) > 190) light++;
        }
        if (visible > 0) {
          if (dark / visible >= 0.6) tone = 'dark';
          else if (light / visible >= 0.6) tone = 'light';
        }
      }
    }
  } catch {
    tone = '';
  }
  cache.set(src, tone);
  return tone;
}

function apply(img: HTMLImageElement) {
  if (!img.complete || img.naturalWidth === 0) return;
  const tone = toneFor(img);
  if (tone) img.dataset.tone = tone;
  else delete img.dataset.tone;
}

document.addEventListener(
  'load',
  (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.hasAttribute('data-contrast-logo')) apply(t);
  },
  true,
);

function sweep() {
  document.querySelectorAll<HTMLImageElement>('img[data-contrast-logo]').forEach(apply);
}

document.addEventListener('astro:page-load', sweep);
sweep();
