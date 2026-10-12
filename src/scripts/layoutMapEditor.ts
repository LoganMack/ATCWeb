// Client behavior for /admin/circuits/<id>/map/<layoutId> (the layout map editor):
//   - previewing a chosen map file, and (for a PNG/JPG/WebP) tracing it into an SVG in the browser
//     with the vendored imagetracer, swapped into the upload when the form is submitted;
//   - placing and dragging incident pins and the two optional pit lane points on the map.
// Everything the server needs is written into hidden inputs (pins_json, pit_*_x/y) on every change.
import imageTracer from './vendor/imagetracer.js';

interface Pt {
  x: number;
  y: number;
}
type Armed = { kind: 'pin'; id: string } | { kind: 'pit'; which: 'entry' | 'exit' } | null;

const tracer = imageTracer as unknown as {
  imagedataToSVG: (img: { width: number; height: number; data: Uint8ClampedArray }, opts: Record<string, unknown>) => string;
};

const MAX_TRACE_SIDE = 900;

/** Black/white-ify the image (padded to a square), trace it, and return a transparent SVG of just the white shapes. */
async function traceToSvg(file: File, opts: { threshold: number; invert: boolean; speck: number }): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_TRACE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const side = Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Whatever the image doesn't cover (transparent areas, the padding) counts as "background".
  ctx.fillStyle = opts.invert ? '#fff' : '#000';
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(bmp, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, side, side);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (opts.invert) lum = 255 - lum;
    const v = lum > opts.threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  const raw = tracer.imagedataToSVG(
    { width: side, height: side, data: d },
    {
      ltres: 1,
      qtres: 1,
      pathomit: opts.speck,
      colorsampling: 0,
      numberofcolors: 2,
      pal: [
        { r: 0, g: 0, b: 0, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 },
      ],
      blurradius: 0,
      strokewidth: 0,
      roundcoords: 1,
      viewbox: true,
      desc: false,
    }
  );
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const svg = doc.documentElement;
  svg.querySelectorAll('path').forEach((p) => {
    const fill = (p.getAttribute('fill') ?? '').replace(/\s/g, '');
    if (fill === 'rgb(0,0,0)') {
      p.remove();
      return;
    }
    p.setAttribute('fill', '#ffffff');
    p.removeAttribute('stroke');
    p.removeAttribute('stroke-width');
    p.removeAttribute('opacity');
  });
  svg.removeAttribute('desc');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(svg);
}

function initLayoutMapEditor() {
  const found = document.querySelector<HTMLFormElement>('[data-map-editor]');
  if (!found || found.dataset.editorReady) return;
  found.dataset.editorReady = '1';
  const form: HTMLFormElement = found;

  const plate = form.querySelector<HTMLElement>('[data-editor-plate]')!;
  const img = form.querySelector<HTMLImageElement>('[data-editor-img]');
  const pinLayer = form.querySelector<HTMLElement>('[data-editor-pins]')!;
  const flagLayer = form.querySelector<HTMLElement>('[data-editor-flags]')!;
  const banner = form.querySelector<HTMLElement>('[data-editor-banner]')!;
  const bannerText = form.querySelector<HTMLElement>('[data-editor-banner-text]')!;
  const pinsInput = form.querySelector<HTMLInputElement>('input[name="pins_json"]')!;
  const fileInput = form.querySelector<HTMLInputElement>('input[name="map_file"]')!;
  const initial = JSON.parse(form.querySelector('[data-editor-initial]')?.textContent ?? '{}') as {
    pins: { penaltyId: string; x: number; y: number }[];
    pitEntry: Pt | null;
    pitExit: Pt | null;
  };

  const pins = new Map<string, Pt>(initial.pins.map((p) => [p.penaltyId, { x: p.x, y: p.y }]));
  const pit: Record<'entry' | 'exit', Pt | null> = { entry: initial.pitEntry, exit: initial.pitExit };
  let armed: Armed = null;

  const rows = Array.from(form.querySelectorAll<HTMLElement>('[data-incident-row]'));
  const rowById = new Map(rows.map((r) => [r.dataset.incidentId!, r]));

  const pct = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
  function pointFromEvent(e: { clientX: number; clientY: number }): Pt {
    const r = plate.getBoundingClientRect();
    return { x: pct(((e.clientX - r.left) / r.width) * 100), y: pct(((e.clientY - r.top) / r.height) * 100) };
  }

  function setArmed(next: Armed) {
    armed = next;
    plate.toggleAttribute('data-armed', next !== null);
    banner.classList.toggle('hidden', next === null);
    if (next?.kind === 'pin') {
      bannerText.textContent = `Click the map to place: ${rowById.get(next.id)?.dataset.incidentLabel ?? 'incident'}`;
    } else if (next?.kind === 'pit') {
      bannerText.textContent = `Click the map to place the pit ${next.which}`;
    }
  }

  function sync() {
    pinsInput.value = JSON.stringify(Array.from(pins, ([penaltyId, p]) => ({ penaltyId, x: p.x, y: p.y })));
    for (const which of ['entry', 'exit'] as const) {
      const p = pit[which];
      form.querySelector<HTMLInputElement>(`input[name="pit_${which}_x"]`)!.value = p ? String(p.x) : '';
      form.querySelector<HTMLInputElement>(`input[name="pit_${which}_y"]`)!.value = p ? String(p.y) : '';
      form.querySelector<HTMLElement>(`[data-pit-state="${which}"]`)!.textContent = p ? 'Placed on map' : 'Not placed';
      form.querySelector<HTMLElement>(`[data-pit-clear="${which}"]`)?.classList.toggle('hidden', !p);
    }
    for (const row of rows) {
      const placed = pins.has(row.dataset.incidentId!);
      row.dataset.placed = placed ? 'true' : 'false';
      row.querySelector<HTMLElement>('[data-row-place]')!.textContent = placed ? 'Move' : 'Place';
      row.querySelector<HTMLElement>('[data-row-remove]')?.classList.toggle('hidden', !placed);
      row.querySelector<HTMLElement>('[data-row-dot]')?.classList.toggle('opacity-30', !placed);
    }
    const count = pins.size;
    const counter = form.querySelector<HTMLElement>('[data-pin-count]');
    if (counter) counter.textContent = `${count} of ${rows.length} placed`;
  }

  function render() {
    pinLayer.replaceChildren(
      ...Array.from(pins, ([id, p]) => {
        const row = rowById.get(id);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'map-pin';
        el.dataset.pinId = id;
        el.dataset.kind = row?.dataset.kind ?? 'penalty';
        el.dataset.draggable = '';
        if (row?.dataset.appealed === 'true') el.dataset.appealed = '';
        el.title = row?.dataset.incidentLabel ?? '';
        el.style.left = `${p.x}%`;
        el.style.top = `${p.y}%`;
        return el;
      })
    );
    flagLayer.replaceChildren(
      ...(['entry', 'exit'] as const).flatMap((which) => {
        const p = pit[which];
        if (!p) return [];
        const level = form.querySelector<HTMLSelectElement>(`select[name="pit_${which}_difficulty"]`)?.value || 'none';
        const el = document.createElement('span');
        el.className = 'map-flag';
        el.dataset.level = level;
        el.dataset.flagFor = which;
        el.style.left = `${p.x}%`;
        el.style.top = `${p.y}%`;
        el.innerHTML = `<i></i>${which === 'entry' ? 'PIT IN' : 'PIT OUT'}`;
        return [el];
      })
    );
    sync();
  }

  // --- picking things up --------------------------------------------------
  form.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const place = t.closest<HTMLElement>('[data-row-place]');
    if (place) {
      const id = place.closest<HTMLElement>('[data-incident-row]')!.dataset.incidentId!;
      setArmed({ kind: 'pin', id });
      return;
    }
    const remove = t.closest<HTMLElement>('[data-row-remove]');
    if (remove) {
      pins.delete(remove.closest<HTMLElement>('[data-incident-row]')!.dataset.incidentId!);
      render();
      return;
    }
    const pitPlace = t.closest<HTMLElement>('[data-pit-place]');
    if (pitPlace) {
      setArmed({ kind: 'pit', which: pitPlace.dataset.pitPlace as 'entry' | 'exit' });
      return;
    }
    const pitClear = t.closest<HTMLElement>('[data-pit-clear]');
    if (pitClear) {
      pit[pitClear.dataset.pitClear as 'entry' | 'exit'] = null;
      render();
      return;
    }
    if (t.closest('[data-editor-cancel-arm]')) {
      setArmed(null);
      return;
    }
    // Dropping the picked-up thing on the map.
    if (armed && t.closest('[data-editor-plate]') && !t.closest('.map-pin')) {
      const p = pointFromEvent(e);
      if (armed.kind === 'pin') pins.set(armed.id, p);
      else pit[armed.which] = p;
      setArmed(null);
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) setArmed(null);
  });
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).matches('select[name^="pit_"]')) render();
  });

  // --- dragging pins ------------------------------------------------------
  let drag: { id: string; el: HTMLElement } | null = null;
  pinLayer.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.map-pin');
    if (!el || armed) return;
    drag = { id: el.dataset.pinId!, el };
    el.setPointerCapture(e.pointerId);
    el.dataset.selected = '';
    e.preventDefault();
  });
  pinLayer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointFromEvent(e);
    pins.set(drag.id, p);
    drag.el.style.left = `${p.x}%`;
    drag.el.style.top = `${p.y}%`;
  });
  const endDrag = () => {
    if (!drag) return;
    delete drag.el.dataset.selected;
    drag = null;
    sync();
  };
  pinLayer.addEventListener('pointerup', endDrag);
  pinLayer.addEventListener('pointercancel', endDrag);

  // --- the map file: preview, and optional trace to SVG -------------------
  const tracePanel = form.querySelector<HTMLElement>('[data-trace-panel]')!;
  const traceOn = form.querySelector<HTMLInputElement>('[data-trace-on]')!;
  const thresholdInput = form.querySelector<HTMLInputElement>('[data-trace-threshold]')!;
  const speckInput = form.querySelector<HTMLInputElement>('[data-trace-speck]')!;
  const invertInput = form.querySelector<HTMLInputElement>('[data-trace-invert]')!;
  const traceStatus = form.querySelector<HTMLElement>('[data-trace-status]')!;
  const originalSrc = img?.getAttribute('src') ?? '';
  let previewUrl: string | null = null;
  let traced: File | null = null;
  let traceRun = 0;

  function setPreview(url: string | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    if (img) img.src = url ?? originalSrc;
  }

  async function runTrace() {
    const file = fileInput.files?.[0];
    if (!file || file.type === 'image/svg+xml' || !traceOn.checked) return;
    const run = ++traceRun;
    traceStatus.textContent = 'Tracing…';
    try {
      const svg = await traceToSvg(file, { threshold: Number(thresholdInput.value), invert: invertInput.checked, speck: Number(speckInput.value) });
      if (run !== traceRun) return;
      traced = new File([svg], 'layout-map.svg', { type: 'image/svg+xml' });
      setPreview(URL.createObjectURL(traced));
      traceStatus.textContent = `Traced: ${Math.round(svg.length / 1024)} KB SVG`;
    } catch (err) {
      console.error('Trace failed:', err);
      traced = null;
      traceStatus.textContent = 'Couldn’t trace this image — it will be uploaded as-is.';
    }
  }

  let traceTimer: number | undefined;
  const retrace = () => {
    window.clearTimeout(traceTimer);
    traceTimer = window.setTimeout(runTrace, 180);
  };
  fileInput.addEventListener('change', () => {
    traced = null;
    const file = fileInput.files?.[0];
    const isRaster = !!file && file.type !== 'image/svg+xml';
    tracePanel.classList.toggle('hidden', !isRaster);
    if (!file) {
      setPreview(null);
      return;
    }
    if (!isRaster) {
      setPreview(URL.createObjectURL(file));
      return;
    }
    if (traceOn.checked) runTrace();
    else setPreview(URL.createObjectURL(file));
  });
  traceOn.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (traceOn.checked) runTrace();
    else {
      traced = null;
      traceStatus.textContent = '';
      setPreview(URL.createObjectURL(file));
    }
  });
  [thresholdInput, speckInput, invertInput].forEach((el) => el.addEventListener('input', retrace));

  // Swap the chosen raster for its traced SVG as the form's data is gathered. The `formdata` event fires
  // whenever a FormData is built from this form (a normal submit, or hard-form-submit.ts's fetch), so this
  // works either way without depending on listener order.
  form.addEventListener('formdata', (e) => {
    const chosen = fileInput.files?.[0];
    if (traced && traceOn.checked && chosen && chosen.type !== 'image/svg+xml') {
      e.formData.set('map_file', traced, 'layout-map.svg');
    }
  });
  form.addEventListener('submit', sync);

  render();
}

document.addEventListener('astro:page-load', initLayoutMapEditor);
initLayoutMapEditor();
