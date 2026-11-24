/**
 * The Series iRating history chart a list row opens (FR7; NFR6): every rated race of one driver in one kind,
 * drawn as SVG on the round timeline the ratings fragment embeds, so season labels line up across drivers;
 * the line runs straight across missed rounds, blue where it rises and red where it falls (rating/segments).
 * Hover or keyboard focus (left/right arrows, Home, End) shows the race, the position used and the rating
 * after it; the plot's label and a hidden table carry the values for screen readers. Colours come from the
 * theme tokens through currentColor, so both themes work, and nothing animates.
 */
import type { RatingHistoryPoint } from '../lib/db/seriesRatings';
import { directionRuns, segmentDirections, type SegmentDirection } from '../lib/rating/segments';
import type { TimelineSlot } from '../lib/rating/timeline';

export const CHART_HEIGHT = 240;
const PAD = { left: 44, right: 14, top: 22, bottom: 24 };
const SVG_NS = 'http://www.w3.org/2000/svg';
/** A season label is left out when it would start closer than this to the previous label. */
const SEASON_LABEL_GAP = 56;
/** Long season names ("ATC4 Off-Season Fun Series") also need clear space after the previous label's end,
 *  estimated at 6 px a character at the 10 px font so nothing is measured in the browser. */
const SEASON_LABEL_CHAR_W = 6;
const SEASON_LABEL_PAD = 8;

/** A history point as the chart takes it: an old cached history may lack i or n, and then uses even spacing. */
export type ChartPoint = Omit<RatingHistoryPoint, 'i' | 'n'> & Partial<Pick<RatingHistoryPoint, 'i' | 'n'>>;

/** Where each drawn point sits: a slot and an offset inside it (0 to 1), plus the season marks. */
export interface Placement {
  placed: { point: ChartPoint; slot: number; offset: number }[];
  slotCount: number;
  marks: { slot: number; label: string }[];
}

export interface ChartGeometry {
  xs: number[];
  ys: number[];
  /** One SVG path per direction run; [] for fewer than 2 points. */
  runs: { direction: SegmentDirection; d: string }[];
  /** The single point's position, else null. */
  dot: { x: number; y: number } | null;
  /** Rating gridlines: value and y. */
  ticks: { value: number; y: number }[];
  /** Each season's first slot: x, name, whether it is the first mark and whether its name is drawn. */
  seasons: { x: number; name: string; first: boolean; labelled: boolean }[];
}

/** Even spacing in race order, one slot per point, for a stale fragment or history (BR1.13). */
export function legacyPlacement(points: readonly ChartPoint[]): Placement {
  const placed = points.map((point, k) => ({ point, slot: k, offset: 0.5 }));
  const marks = points.flatMap((p, k) =>
    k === 0 || p.s !== points[k - 1].s ? [{ slot: k, label: p.s }] : [],
  );
  return { placed, slotCount: points.length, marks };
}

const hasSlotKeys = (p: ChartPoint) => Number.isInteger(p.i) && Number.isInteger(p.n);

/**
 * Places each point in its round's slot, races spread evenly inside it; a point whose round has no slot
 * (excluded, hidden from a broadcaster, or newer than the slot list) is skipped. Falls back to even spacing
 * when there is no slot list or any point lacks i or n.
 */
export function placeOnTimeline(
  points: readonly ChartPoint[],
  timeline: readonly TimelineSlot[] | null,
): Placement {
  if (timeline === null || !points.every(hasSlotKeys)) return legacyPlacement(points);
  const slotOf = new Map(timeline.map((s, k) => [s.i, k]));
  const marks = timeline.flatMap((s, k) =>
    k === 0 || s.s !== timeline[k - 1].s ? [{ slot: k, label: s.s }] : [],
  );
  const placed: Placement['placed'] = [];
  for (const point of points) {
    const slot = slotOf.get(point.i as number);
    if (slot === undefined) continue;
    const n = point.n as number;
    const offset = n > 1 ? (Math.min(n, Math.max(1, point.r)) - 0.5) / n : 0.5;
    placed.push({ point, slot, offset });
  }
  // Left to right even if the history and the slot list ever disagree on round order.
  placed.sort((a, b) => a.slot - b.slot || a.offset - b.offset);
  return { placed, slotCount: timeline.length, marks };
}

/** A "nice" step for about four gridlines over the span. */
function tickStep(span: number): number {
  const raw = Math.max(1, span / 4);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
}

/** Points sit at their slot and offset across the plot; runs, the dot and the season marks follow. */
export function chartGeometry(placement: Placement, width: number, height = CHART_HEIGHT): ChartGeometry {
  const values = placement.placed.map((p) => p.point.v);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const slots = Math.max(1, placement.slotCount);
  const ticks: { value: number; y: number }[] = [];
  let y = (_v: number) => PAD.top + plotH / 2;
  if (values.length > 0) {
    const step = tickStep(Math.max(...values) - Math.min(...values) || 100);
    const lo = Math.floor(Math.min(...values) / step) * step;
    const hi = Math.max(lo + step, Math.ceil(Math.max(...values) / step) * step);
    y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;
    for (let v = lo; v <= hi; v += step) ticks.push({ value: v, y: y(v) });
  }
  const xs = placement.placed.map((p) => PAD.left + ((p.slot + p.offset) / slots) * plotW);
  const ys = values.map(y);
  const runs = directionRuns(segmentDirections(values)).map((run) => ({
    direction: run.direction,
    d: xs
      .slice(run.from, run.to + 1)
      .map((px, k) => `${k === 0 ? 'M' : 'L'}${px.toFixed(1)},${ys[run.from + k].toFixed(1)}`)
      .join(' '),
  }));
  const dot = xs.length === 1 ? { x: xs[0], y: ys[0] } : null;
  let lastLabelX = PAD.left;
  let lastLabelEnd = -Infinity;
  const seasons = placement.marks.map((mark, k) => {
    const x = PAD.left + (mark.slot / slots) * plotW;
    const first = k === 0;
    // Where renderHistoryChart draws the text: at the mark for the first season, 3 px right of it otherwise.
    const textStart = first ? x : x + 3;
    const labelled =
      mark.label !== '' &&
      (first || (x - lastLabelX >= SEASON_LABEL_GAP && textStart >= lastLabelEnd + SEASON_LABEL_PAD));
    if (labelled) {
      lastLabelX = x;
      lastLabelEnd = textStart + mark.label.length * SEASON_LABEL_CHAR_W;
    }
    return { x, name: mark.label, first, labelled };
  });
  return { xs, ys, runs, dot, ticks, seasons };
}

/** The point nearest an x position. */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  return best;
}

export function formatRaceDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Which race (season, track, race number in a multi-race round, date). */
export function raceLabel(p: ChartPoint): string {
  return [p.s, p.t, p.r > 0 ? `Race ${p.r}` : null, formatRaceDate(p.d)].filter(Boolean).join(' · ');
}

/** The position the rating used: overall position for Overall, class position for a class. */
export function positionLabel(p: ChartPoint, kindLabel: string): string {
  return `P${p.p} of ${p.f} ${kindLabel === 'Overall' ? 'overall' : `in ${kindLabel}`}`;
}

/** The tooltip's lines for one point. */
export function pointLines(p: ChartPoint, kindLabel: string): [string, string] {
  return [raceLabel(p), `${positionLabel(p, kindLabel)} · Rating ${p.v}`];
}

const KEYS_HINT = 'Use the left and right arrow keys to step through the races.';

/** The plot's spoken label: the first and last rating and the drawn race count. */
function plotLabel(points: readonly ChartPoint[], name: string, kindLabel: string): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length === 1)
    return `${name}’s ${kindLabel} rating chart, ${first.v} after 1 rated race. ${KEYS_HINT}`;
  return `${name}’s ${kindLabel} rating chart, from ${first.v} to ${last.v} over ${points.length} rated races. ${KEYS_HINT}`;
}

type Attrs = Record<string, string | number | null | undefined>;

function node(tag: string, attrs: Attrs = {}, svg = false): Element {
  const out = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) out.setAttribute(name, String(value));
  }
  return out;
}

function text(tag: string, attrs: Attrs, content: string, svg = false): Element {
  const out = node(tag, attrs, svg);
  out.textContent = content;
  return out;
}

/**
 * Draws the chart into `container`, replacing what it holds. The width is the container's own, so the chart
 * fills the row; it is drawn once per open. With a slot list, points sit on the shared timeline; without one
 * (or for an old history), races are spaced evenly.
 */
export function renderHistoryChart(
  container: HTMLElement,
  allPoints: readonly ChartPoint[],
  opts: { name: string; kindLabel: string; timeline?: readonly TimelineSlot[] | null },
): void {
  const placement = placeOnTimeline(allPoints, opts.timeline ?? null);
  const points = placement.placed.map((p) => p.point);
  if (points.length === 0) {
    container.replaceChildren(
      text(
        'p',
        { class: 'text-sm text-white/60', 'data-chart-empty': '' },
        allPoints.length === 0
          ? `${opts.name} has no rated races in ${opts.kindLabel} yet.`
          : `${opts.name}'s rated races in ${opts.kindLabel} are not on the chart timeline yet.`,
      ),
    );
    return;
  }
  const width = Math.max(320, Math.round(container.clientWidth || 720));
  const geo = chartGeometry(placement, width);

  const svg = node(
    'svg',
    {
      width: '100%',
      height: CHART_HEIGHT,
      viewBox: `0 0 ${width} ${CHART_HEIGHT}`,
      'aria-hidden': 'true',
      class: 'block overflow-visible',
    },
    true,
  );
  for (const tick of geo.ticks) {
    svg.append(
      // Faint through the stroke's own opacity: only colour utilities the site already has keep the theme proof.
      node(
        'line',
        {
          x1: PAD.left,
          x2: width - PAD.right,
          y1: tick.y,
          y2: tick.y,
          stroke: 'currentColor',
          'stroke-opacity': 0.5,
          class: 'text-white/20',
        },
        true,
      ),
      text(
        'text',
        {
          x: PAD.left - 6,
          y: tick.y + 3,
          'text-anchor': 'end',
          'font-size': 10,
          fill: 'currentColor',
          class: 'text-white/40',
        },
        String(tick.value),
        true,
      ),
    );
  }
  // Each season's first slot gets a divider (except the first) and, when it fits, its name.
  for (const season of geo.seasons) {
    if (!season.first) {
      svg.append(
        node(
          'line',
          {
            x1: season.x,
            x2: season.x,
            y1: PAD.top - 6,
            y2: CHART_HEIGHT - PAD.bottom,
            stroke: 'currentColor',
            'stroke-dasharray': '3 3',
            class: 'text-white/20',
          },
          true,
        ),
      );
    }
    if (!season.labelled) continue;
    svg.append(
      text(
        'text',
        {
          x: season.first ? season.x : season.x + 3,
          y: PAD.top - 9,
          'font-size': 10,
          fill: 'currentColor',
          class: 'text-white/40',
        },
        season.name,
        true,
      ),
    );
  }
  for (const run of geo.runs) {
    svg.append(
      node(
        'path',
        {
          d: run.d,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          class: run.direction === 'down' ? 'text-brand-pink' : 'text-brand-blue',
          'data-dir': run.direction,
        },
        true,
      ),
    );
  }
  if (geo.dot) {
    svg.append(
      node(
        'circle',
        {
          cx: geo.dot.x,
          cy: geo.dot.y,
          r: 3,
          fill: 'currentColor',
          class: 'text-brand-blue',
          'data-chart-dot': '',
        },
        true,
      ),
    );
  }
  const guide = node(
    'line',
    {
      y1: PAD.top,
      y2: CHART_HEIGHT - PAD.bottom,
      stroke: 'currentColor',
      class: 'text-white/40',
      visibility: 'hidden',
    },
    true,
  );
  const marker = node(
    'circle',
    { r: 4.5, fill: 'currentColor', stroke: 'currentColor', class: 'text-brand-gold', visibility: 'hidden' },
    true,
  );
  svg.append(guide, marker);

  const tipRace = text('span', { class: 'block font-semibold' }, '');
  const tipValue = text('span', { class: 'block text-white/60' }, '');
  const tip = node('div', {
    class:
      'pointer-events-none absolute z-20 hidden max-w-[16rem] rounded-md border border-white/10 bg-brand-ink px-2 py-1 text-xs text-white',
    'data-chart-tip': '',
  });
  tip.append(tipRace, tipValue);
  const status = node('p', { class: 'sr-only', 'aria-live': 'polite', 'data-chart-status': '' });

  const plot = node('div', {
    class: 'relative rounded-md border border-transparent outline-none focus:border-brand-primary',
    tabindex: 0,
    role: 'group',
    'aria-label': plotLabel(points, opts.name, opts.kindLabel),
    'data-chart-plot': '',
  }) as HTMLElement;
  plot.append(svg, tip);

  let active = points.length - 1;
  const show = (i: number, announce: boolean) => {
    active = Math.max(0, Math.min(points.length - 1, i));
    const [race, value] = pointLines(points[active], opts.kindLabel);
    tipRace.textContent = race;
    tipValue.textContent = value;
    const x = geo.xs[active];
    const y = geo.ys[active];
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    marker.setAttribute('cx', String(x));
    marker.setAttribute('cy', String(y));
    guide.setAttribute('visibility', 'visible');
    marker.setAttribute('visibility', 'visible');
    const leftPct = (x / width) * 100;
    tip.classList.remove('hidden');
    tip.setAttribute(
      'style',
      `top:${Math.max(0, y - 52)}px;${leftPct > 60 ? `right:${(100 - leftPct).toFixed(2)}%` : `left:${leftPct.toFixed(2)}%`}`,
    );
    if (announce) status.textContent = `${race}. ${value}`;
  };
  const hide = () => {
    tip.classList.add('hidden');
    guide.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
  };

  plot.addEventListener('pointermove', (e) => {
    const rect = (svg as SVGSVGElement).getBoundingClientRect();
    if (!rect.width) return;
    show(nearestIndex(geo.xs, (((e as PointerEvent).clientX - rect.left) / rect.width) * width), false);
  });
  plot.addEventListener('pointerleave', () => {
    if (document.activeElement !== plot) hide();
  });
  plot.addEventListener('focus', () => show(active, true));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    const next =
      key === 'ArrowLeft'
        ? active - 1
        : key === 'ArrowRight'
          ? active + 1
          : key === 'Home'
            ? 0
            : key === 'End'
              ? points.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    show(next, true);
  });

  const table = node('table', { class: 'sr-only' });
  table.append(text('caption', {}, `${opts.name}’s ${opts.kindLabel} rating, race by race`));
  const head = node('tr');
  for (const label of ['Race', 'Position', 'Rating after']) head.append(text('th', { scope: 'col' }, label));
  const thead = node('thead');
  thead.append(head);
  const tbody = node('tbody');
  for (const p of points) {
    const tr = node('tr');
    tr.append(
      text('th', { scope: 'row' }, raceLabel(p)),
      text('td', {}, positionLabel(p, opts.kindLabel)),
      text('td', {}, String(p.v)),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);

  container.replaceChildren(plot, status, table);
}
