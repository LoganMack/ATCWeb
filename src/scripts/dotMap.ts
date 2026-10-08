/**
 * The site's dot-matrix world map — shared by the Calendar's Map view and the
 * Media page's Meetups map. A self-drawn SVG (land outline from
 * src/lib/worldMap.ts, filled with a grid of dots): no tile server, no API key,
 * no third-party requests. Looks live in the `.dot-map` / `.cm-*` rules in
 * global.css.
 *
 * Callers hand over the markup pieces (box, svg, tooltip, legend) and a
 * `getItems()` that returns whatever should be on the map right now; this module
 * does the rest: projection, pan/zoom (drag, buttons, scroll wheel, touch pinch), merging
 * nearby pins into numbered clusters that split apart as you zoom in, hover
 * tooltips, keyboard access, and resize handling. What a tooltip says and what
 * a click does are the caller's business (`tooltip` / `onActivate`).
 */

export interface MapItem<T = unknown> {
  id: string;
  lat: number;
  lng: number;
  /** How many things this pin stands for (events, meetups…); shown as a count badge when > 1, summed when pins merge. */
  weight: number;
  /** Any CSS colour or var(). */
  color: string;
  /** Drawn faded (e.g. a past event). */
  dim?: boolean;
  /** Gets a pulsing ring (e.g. the next upcoming event). */
  pulse?: boolean;
  data: T;
}

/** A MapItem after projection: x/y are map coordinates (see worldMap.ts). */
export type PlacedItem<T = unknown> = MapItem<T> & { x: number; y: number };

export interface MapCluster<T = unknown> {
  x: number;
  y: number;
  items: PlacedItem<T>[];
  weight: number;
}

export interface DotMapOptions<T = unknown> {
  box: HTMLElement;
  svg: SVGSVGElement;
  tip: HTMLElement;
  legend?: HTMLElement | null;
  /** The items to show right now. Called on every refresh(), so it can apply filters. */
  getItems(): MapItem<T>[];
  /** Fill `tipEl` (already emptied) with the hover tooltip for this pin. */
  tooltip(cluster: MapCluster<T>, tipEl: HTMLElement): void;
  /** A single pin (or an un-splittable cluster) was clicked. Merged pins that can still split zoom in instead. */
  onActivate(cluster: MapCluster<T>): void;
  /** Legend entries to show for the current items, e.g. [{label:'Sprint', color:'var(--m-pin-sprint)'}]. */
  legendFor?(items: MapItem<T>[]): { label: string; color: string }[];
}

export interface DotMap {
  /** Re-read getItems() and redraw; refits the view unless `keepView`. */
  refresh(keepView?: boolean): void;
  /** Highlight pins containing any of these item ids (or none). */
  setSelected(ids: string[] | null): void;
  /** Re-measure after the container was shown/resized. */
  resize(): void;
}

const PIN_PX = 6; // pin radius on screen
const MERGE_PX = 15; // pins closer than this (screen px) merge into one

export async function createDotMap<T>(opts: DotMapOptions<T>): Promise<DotMap> {
  const wm = await import('../lib/worldMap');
  const { box, svg, tip, legend } = opts;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };

  // Static layers: dot pattern, graticule, land.
  svg.replaceChildren();
  const defs = mk('defs');
  const dots = mk('pattern', { id: 'cm-dots', width: 5, height: 5, patternUnits: 'userSpaceOnUse' });
  dots.appendChild(mk('circle', { class: 'cm-dot', cx: 2.5, cy: 2.5, r: 1 }));
  defs.appendChild(dots);
  svg.appendChild(defs);
  svg.appendChild(mk('path', { class: 'cm-land', d: wm.LAND_PATH }));
  const pinsLayer = mk('g');
  svg.appendChild(pinsLayer);

  let items: PlacedItem<T>[] = [];
  let vb = { x: 0, y: 0, w: wm.MAP_W, h: wm.MAP_H };
  let clusteredAtW = -1;
  let selected: string[] | null = null;
  let moved = false;

  const size = () => {
    const r = svg.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  const aspect = () => {
    const s = size();
    return s.w > 0 ? s.h / s.w : 0.5;
  };
  const maxW = () => Math.max(wm.MAP_W, wm.MAP_H / aspect());
  const minW = () => wm.MAP_W / 40;

  function clampView() {
    vb.w = Math.min(maxW(), Math.max(minW(), vb.w));
    vb.h = vb.w * aspect();
    const cx = Math.min(wm.MAP_W, Math.max(0, vb.x + vb.w / 2));
    const cy = Math.min(wm.MAP_H, Math.max(0, vb.y + vb.h / 2));
    vb.x = cx - vb.w / 2;
    vb.y = cy - vb.h / 2;
  }

  // Pins keep a fixed pixel size: scale them down as the view zooms in.
  function placePins() {
    const s = size();
    const k = s.w > 0 ? vb.w / s.w : 1;
    pinsLayer.querySelectorAll<SVGGElement>('[data-pin]').forEach((pin) => {
      pin.setAttribute('transform', `translate(${pin.dataset.x},${pin.dataset.y}) scale(${k.toFixed(4)})`);
    });
  }

  function applyView() {
    clampView();
    svg.setAttribute('viewBox', `${vb.x.toFixed(2)} ${vb.y.toFixed(2)} ${vb.w.toFixed(2)} ${vb.h.toFixed(2)}`);
    // Zoom level changed: pins may need to merge or split. Panning alone only moves them.
    if (Math.abs(vb.w - clusteredAtW) > 1e-6) renderPins();
    else placePins();
  }

  function fitTo(pts: { x: number; y: number }[], capW = Infinity) {
    const a = aspect();
    if (pts.length === 0) {
      vb.w = maxW();
      vb.h = vb.w * a;
      vb.x = (wm.MAP_W - vb.w) / 2;
      vb.y = (wm.MAP_H - vb.h) / 2;
    } else {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      const w = Math.min(capW, maxW(), Math.max(bw * 1.45 + 60, (bh * 1.45 + 40) / a, wm.MAP_W / 7));
      vb = { x: cx - w / 2, y: cy - (w * a) / 2, w, h: w * a };
    }
    applyView();
  }

  function zoomAt(factor: number, fx = 0.5, fy = 0.5) {
    // fx/fy: the point to keep still, as a 0..1 fraction of the visible area.
    const px = vb.x + vb.w * fx;
    const py = vb.y + vb.h * fy;
    vb.w /= factor;
    vb.h = vb.w * aspect();
    vb.x = px - vb.w * fx;
    vb.y = py - vb.h * fy;
    applyView();
  }

  function clusterize(): MapCluster<T>[] {
    const s = size();
    const k = s.w > 0 ? vb.w / s.w : 1; // map units per screen px
    const out: (MapCluster<T> & { n: number })[] = [];
    for (const it of [...items].sort((a, b) => a.x - b.x || a.y - b.y)) {
      const hit = out.find((c) => Math.hypot(c.x - it.x, c.y - it.y) < MERGE_PX * k);
      if (hit) {
        hit.x = (hit.x * hit.n + it.x) / (hit.n + 1);
        hit.y = (hit.y * hit.n + it.y) / (hit.n + 1);
        hit.n += 1;
        hit.items.push(it);
        hit.weight += it.weight;
      } else out.push({ x: it.x, y: it.y, n: 1, items: [it], weight: it.weight });
    }
    return out;
  }

  function hideTip() {
    tip.classList.add('hidden');
  }
  function showTip(c: MapCluster<T>, pin: SVGGElement) {
    tip.replaceChildren();
    opts.tooltip(c, tip);
    tip.classList.remove('hidden');
    const b = box.getBoundingClientRect();
    const r = pin.getBoundingClientRect();
    const cx = r.left + r.width / 2 - b.left;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(8, cx - tw / 2), Math.max(8, b.width - tw - 8))}px`;
    const above = r.top - b.top - th - 10;
    tip.style.top = `${above >= 8 ? above : r.bottom - b.top + 10}px`;
  }

  function markSelected() {
    pinsLayer.querySelectorAll<SVGGElement>('[data-pin]').forEach((p) => {
      const ids = (p.dataset.ids ?? '').split('\n');
      p.classList.toggle('is-selected', !!selected && ids.some((i) => selected!.includes(i)));
    });
  }

  function activate(c: MapCluster<T>) {
    if (c.items.length > 1 && vb.w > minW() * 1.05) {
      // Merged pin: zoom in so its members separate.
      hideTip();
      fitTo(c.items, vb.w * 0.55);
      return;
    }
    opts.onActivate(c);
  }

  function renderPins() {
    clusteredAtW = vb.w;
    pinsLayer.replaceChildren();
    for (const c of clusterize()) {
      const rep = c.items.find((i) => !i.dim) ?? c.items[0];
      const pin = mk('g', { class: `cm-pin${rep.dim ? ' is-past' : ''}`, tabindex: 0, role: 'button' });
      pin.setAttribute('aria-label', c.items.length > 1 ? `${c.weight} here, zoom in` : 'Map pin');
      pin.dataset.pin = '1';
      pin.dataset.x = c.x.toFixed(2);
      pin.dataset.y = c.y.toFixed(2);
      pin.dataset.ids = c.items.map((i) => i.id).join('\n');
      pin.style.setProperty('--pin', rep.color);
      const r = c.weight > 1 ? 8.5 : PIN_PX;
      if (c.items.some((i) => i.pulse)) pin.appendChild(mk('circle', { class: 'cm-pulse', r: r + 1 }));
      pin.appendChild(mk('circle', { class: 'cm-pin-sel', r: r + 5 }));
      pin.appendChild(mk('circle', { class: 'cm-pin-body', r }));
      if (c.weight > 1) {
        const t = mk('text', { class: 'cm-pin-count' });
        t.textContent = String(c.weight);
        pin.appendChild(t);
      }
      pin.addEventListener('pointerenter', (ev) => {
        if ((ev as PointerEvent).pointerType === 'mouse') showTip(c, pin);
      });
      pin.addEventListener('pointerleave', hideTip);
      pin.addEventListener('focus', () => showTip(c, pin));
      pin.addEventListener('blur', hideTip);
      pin.addEventListener('click', () => {
        if (!moved) activate(c);
      });
      pin.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          activate(c);
        }
      });
      pinsLayer.appendChild(pin);
    }
    markSelected();
    pinsLayer.querySelectorAll('.is-selected').forEach((p) => pinsLayer.appendChild(p)); // selected on top
    if (legend) {
      legend.replaceChildren();
      for (const e of opts.legendFor?.(items) ?? []) {
        const item = document.createElement('span');
        const dot = document.createElement('i');
        dot.style.setProperty('--c', e.color);
        item.append(dot, document.createTextNode(e.label));
        legend.appendChild(item);
      }
    }
    placePins();
  }

  // Drag to pan (one pointer) and pinch to zoom (two pointers, touch). Window-level move/up listeners
  // (not pointer capture) so a plain click still reaches the pin under the cursor.
  const pointers = new Map<number, { x: number; y: number }>();
  let pan: { x: number; y: number; vx: number; vy: number } | null = null;
  let pinch: { dist: number; vb: { x: number; y: number; w: number; h: number }; mx: number; my: number } | null = null;

  const startPan = () => {
    const [p] = [...pointers.values()];
    pan = p ? { x: p.x, y: p.y, vx: vb.x, vy: vb.y } : null;
    pinch = null;
  };
  const startPinch = () => {
    const [a, b] = [...pointers.values()];
    pan = null;
    pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), vb: { ...vb }, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    moved = true; // a pinch is never a click
    hideTip();
  };
  const onMove = (m: PointerEvent) => {
    const p = pointers.get(m.pointerId);
    if (!p) return;
    p.x = m.clientX;
    p.y = m.clientY;
    const r = svg.getBoundingClientRect();
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // Keep the map point that started under the fingers' midpoint under their current midpoint.
      const px = pinch.vb.x + ((pinch.mx - r.left) / r.width) * pinch.vb.w;
      const py = pinch.vb.y + ((pinch.my - r.top) / r.height) * pinch.vb.h;
      vb.w = pinch.vb.w / (dist / pinch.dist);
      vb.h = vb.w * aspect();
      vb.x = px - ((mx - r.left) / r.width) * vb.w;
      vb.y = py - ((my - r.top) / r.height) * vb.h;
      applyView();
      return;
    }
    if (!pan) return;
    const dx = m.clientX - pan.x;
    const dy = m.clientY - pan.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    hideTip();
    box.classList.add('is-dragging');
    vb.x = pan.vx - (dx * vb.w) / r.width;
    vb.y = pan.vy - (dy * vb.w) / r.width;
    applyView();
  };
  const onUp = (u: PointerEvent) => {
    if (!pointers.delete(u.pointerId)) return;
    if (pointers.size === 0) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      box.classList.remove('is-dragging');
      pan = null;
      pinch = null;
      // `moved` is cleared on the next pointerdown, after the click event has had its chance to read it.
    } else if (pointers.size === 1) startPan(); // one finger lifted mid-pinch: carry on panning with the other
  };
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers.size === 0) {
      moved = false;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) startPan();
    else if (pointers.size === 2) startPinch();
  });
  // Scroll wheel (and a trackpad pinch, which browsers report as Ctrl + wheel) zooms toward the cursor.
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    },
    { passive: false }
  );
  box.querySelectorAll<HTMLButtonElement>('[data-map-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const how = btn.dataset.mapZoom;
      if (how === 'in') zoomAt(1.6);
      else if (how === 'out') zoomAt(1 / 1.6);
      else fitTo(items);
    });
  });
  new ResizeObserver(() => {
    if (size().w > 0) applyView();
  }).observe(svg);

  function refresh(keepView = false) {
    items = opts.getItems().map((i) => {
      const [x, y] = wm.project(i.lng, i.lat);
      return { ...i, x, y };
    });
    if (keepView) {
      clusteredAtW = -1;
      applyView();
    } else fitTo(items);
  }

  refresh();
  return {
    refresh,
    setSelected(ids) {
      selected = ids;
      markSelected();
      pinsLayer.querySelectorAll('.is-selected').forEach((p) => pinsLayer.appendChild(p));
    },
    resize: () => applyView(),
  };
}
