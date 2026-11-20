/**
 * The Series iRating history chart a list row opens (FR7; NFR6): every rated race of one driver in one kind,
 * drawn as an SVG line from the compact steps advanced-stats/ratings/history returns. Hover or keyboard focus
 * (left/right arrows, Home, End) shows which race a point is, the position used and the rating after it; a
 * summary sentence and a visually hidden table carry the same values for screen readers. Colours come from the
 * theme tokens through currentColor, so both themes work, and nothing animates.
 */
import type { RatingHistoryPoint } from '../lib/db/seriesRatings';

export const CHART_HEIGHT = 240;
const PAD = { left: 44, right: 14, top: 22, bottom: 24 };
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ChartGeometry {
  xs: number[];
  ys: number[];
  /** SVG path data for the line. */
  path: string;
  /** Rating gridlines: value and y. */
  ticks: { value: number; y: number }[];
  /** The first race of each season after the first: x and the season's name. */
  seasons: { x: number; name: string }[];
}

/** A "nice" step for about four gridlines over the span. */
function tickStep(span: number): number {
  const raw = Math.max(1, span / 4);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
}

/** Races are spaced evenly in race order (not by date), so a long break between seasons takes no room. */
export function chartGeometry(
  points: readonly RatingHistoryPoint[],
  width: number,
  height = CHART_HEIGHT,
): ChartGeometry {
  const values = points.map((p) => p.v);
  const step = tickStep(Math.max(...values) - Math.min(...values) || 100);
  const lo = Math.floor(Math.min(...values) / step) * step;
  const hi = Math.max(lo + step, Math.ceil(Math.max(...values) / step) * step);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;
  const xs = points.map((_, i) => x(i));
  const ys = values.map(y);
  const path = xs.map((px, i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const ticks: { value: number; y: number }[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push({ value: v, y: y(v) });
  const seasons = points.flatMap((p, i) =>
    i > 0 && p.s !== points[i - 1].s ? [{ x: xs[i], name: p.s }] : [],
  );
  return { xs, ys, path, ticks, seasons };
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
export function raceLabel(p: RatingHistoryPoint): string {
  return [p.s, p.t, p.r > 0 ? `Race ${p.r}` : null, formatRaceDate(p.d)].filter(Boolean).join(' · ');
}

/** The position the rating used: overall position for Overall, class position for a class. */
export function positionLabel(p: RatingHistoryPoint, kindLabel: string): string {
  return `P${p.p} of ${p.f} ${kindLabel === 'Overall' ? 'overall' : `in ${kindLabel}`}`;
}

/** The tooltip's lines for one point. */
export function pointLines(p: RatingHistoryPoint, kindLabel: string): [string, string] {
  return [raceLabel(p), `${positionLabel(p, kindLabel)} · Rating ${p.v}`];
}

/** The chart's text equivalent in one sentence. */
export function historySummary(
  points: readonly RatingHistoryPoint[],
  name: string,
  kindLabel: string,
): string {
  if (points.length === 0) return `${name} has no rated races in ${kindLabel} yet.`;
  const values = points.map((p) => p.v);
  const first = points[0];
  const last = points[points.length - 1];
  const races = points.length === 1 ? '1 rated race' : `${points.length} rated races`;
  return (
    `${name}’s ${kindLabel} rating over ${races}, ${formatRaceDate(first.d)} to ${formatRaceDate(last.d)}: ` +
    `now ${last.v}, highest ${Math.max(...values)}, lowest ${Math.min(...values)}.`
  );
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

let chartCount = 0;

/**
 * Draws the chart into `container`, replacing what it holds. The width is the container's own, so the chart
 * fills the row; it is drawn once per open.
 */
export function renderHistoryChart(
  container: HTMLElement,
  points: readonly RatingHistoryPoint[],
  opts: { name: string; kindLabel: string },
): void {
  const id = `rating-chart-${++chartCount}`;
  const summary = text(
    'p',
    { id: `${id}-summary`, class: 'text-sm text-white/60', 'data-chart-summary': '' },
    historySummary(points, opts.name, opts.kindLabel),
  );
  if (points.length === 0) {
    container.replaceChildren(summary);
    return;
  }
  const width = Math.max(320, Math.round(container.clientWidth || 720));
  const geo = chartGeometry(points, width);

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
  // A season's name is left out when it would run into the previous one; its divider stays.
  let lastLabelX = PAD.left;
  for (const season of geo.seasons) {
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
    if (season.x - lastLabelX < 56) continue;
    lastLabelX = season.x;
    svg.append(
      text(
        'text',
        { x: season.x + 3, y: PAD.top - 9, 'font-size': 10, fill: 'currentColor', class: 'text-white/40' },
        season.name,
        true,
      ),
    );
  }
  svg.append(
    text(
      'text',
      { x: PAD.left, y: PAD.top - 9, 'font-size': 10, fill: 'currentColor', class: 'text-white/40' },
      points[0].s,
      true,
    ),
  );
  svg.append(
    node(
      'path',
      {
        d: geo.path,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        class: 'text-brand-blue',
      },
      true,
    ),
  );
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
    'aria-label': `${opts.name}’s rating chart. Use the left and right arrow keys to step through the races.`,
    'aria-describedby': `${id}-summary`,
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

  container.replaceChildren(summary, plot, status, table);
}
