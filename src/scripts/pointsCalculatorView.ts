/**
 * The points calculator's markup (FR4; NFR6): the Points Contenders bars and the results matrix the Scenario
 * Editor shows, built as elements from the view models in pointsCalculatorModel.ts. Names are set as text,
 * never as HTML. Colours come only from the theme tokens, so both themes work; the bars animate only when the
 * reader allows motion. Cell events are wired by src/scripts/pointsCalculator.ts through the data attributes
 * set here; the bars' tooltip (hover, and keyboard focus on each best-possible part) is wired here.
 */
import type { CalculatorSeason } from '../lib/calculator/types';
import {
  barViews,
  contendersFloor,
  matrixRows,
  type BarView,
  type CalcState,
  type ChipTone,
  type MatrixRow,
  type Snapshot,
} from './pointsCalculatorModel';

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** One element: attributes (false, null and undefined are left off), then children (strings become text). */
export function el(
  tag: string,
  attrs: Attrs = {},
  ...children: (Node | string | null | false)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Only colour utilities the site already uses, so the theme proof (tests/theme) holds both themes unchanged.
const CHIP_CLASS: Record<ChipTone, string> = {
  gold: 'border-brand-gold/70 text-brand-gold',
  blue: 'border-brand-primary text-brand-blue',
  pink: 'border-brand-pink/60 text-brand-pink',
  muted: 'border-white/20 text-white/60',
};

function chip(label: string, tone: ChipTone): HTMLElement {
  return el(
    'span',
    {
      class: `inline-block justify-self-start whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${CHIP_CLASS[tone]}`,
      'data-status-chip': '',
    },
    label,
  );
}

// --- Results matrix ---------------------------------------------------------------------------------------

const CELL_CLASS: Record<string, string> = {
  counted: 'text-white',
  dropped: 'text-white/60 line-through',
  future: 'border-dashed text-white/60',
  empty: 'text-white/60',
  special: 'border-dashed text-white/60 cursor-not-allowed',
};

/** An edited cell has the gold outline (and a gold dot); the rest a quiet border. */
function cellBorder(state: string, edited: boolean): string {
  // The blue focus border is the site's own select focus style.
  if (edited) return 'border-brand-gold/70 focus:border-brand-primary';
  return state === 'future'
    ? 'border-white/20 focus:border-brand-primary'
    : 'border-white/10 focus:border-brand-primary';
}

/** FR2.5-FR2.9: Pos and name pinned, one column per round, Total and Status; every cell a button. */
export function matrixElement(season: CalculatorSeason, rows: MatrixRow[]): HTMLElement {
  const head = el(
    'tr',
    { class: 'border-b border-white/10 text-xs uppercase tracking-wide text-white/60' },
    el('th', { scope: 'col', class: 'sticky left-0 z-10 bg-brand-ink px-2 py-2 text-right' }, 'Pos'),
    el(
      'th',
      { scope: 'col', class: 'sticky left-10 z-10 bg-brand-ink px-2 py-2 text-left' },
      season.isTeam ? 'Team' : 'Driver',
    ),
    ...season.rounds.map((r) =>
      el('th', { scope: 'col', class: 'px-1 py-2 text-center', title: r.label }, r.short),
    ),
    el('th', { scope: 'col', class: 'px-2 py-2 text-right' }, 'Total'),
    el('th', { scope: 'col', class: 'px-2 py-2 text-left' }, 'Status'),
  );
  const body = el('tbody');
  for (const row of rows) {
    const tr = el(
      'tr',
      { class: 'border-b border-white/5 last:border-0' },
      el(
        'td',
        { class: 'sticky left-0 z-10 bg-brand-ink px-2 py-1 text-right font-display text-base' },
        String(row.position),
      ),
      el(
        'th',
        {
          scope: 'row',
          class: 'sticky left-10 z-10 max-w-[10rem] truncate bg-brand-ink px-2 py-1 text-left font-normal',
        },
        row.name,
      ),
    );
    for (const cell of row.cells) {
      const button = el(
        'button',
        {
          type: 'button',
          class: `relative h-8 w-11 rounded-md border text-xs tabular-nums outline-none hover:bg-white/5 focus:bg-white/5 ${CELL_CLASS[cell.state]} ${cellBorder(cell.state, cell.edited)}`,
          'aria-label': cell.ariaLabel,
          title: cell.title,
          disabled: cell.disabled,
          'data-cell-entrant': row.key,
          'data-cell-round': cell.roundIndex,
          'data-testid': 'matrix-cell',
          'data-state': cell.state,
          'data-edited': cell.edited ? 'true' : null,
        },
        cell.text,
        cell.edited
          ? el('span', {
              class: 'absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full bg-brand-gold',
              'aria-hidden': 'true',
            })
          : null,
      );
      tr.append(el('td', { class: 'px-0.5 py-1 text-center' }, button));
    }
    tr.append(
      el(
        'td',
        { class: 'px-2 py-1 text-right font-semibold tabular-nums', 'data-matrix-total': row.key },
        String(row.total),
      ),
      el('td', { class: 'px-2 py-1' }, chip(row.status.label, row.status.tone)),
    );
    body.append(tr);
  }
  return el(
    'div',
    { class: 'overflow-x-auto rounded-xl border border-white/10', 'data-results-matrix': '' },
    el(
      'table',
      {
        class: 'data-table w-full text-sm',
        'aria-label': `${season.championshipLabel} championship, ${season.seasonName}, results by round`,
      },
      el('thead', {}, head),
      body,
    ),
  );
}

// --- Points Contenders ------------------------------------------------------------------------------------

/**
 * Every row and the floor overlay share these columns (Pos, name, Pts, status, bar), so each bar track has the
 * same width and position and the Leader’s Floor is one line through all of them. On a phone Pts and the status
 * sit on the name line and the bar wraps under it.
 */
const ROW_GRID = 'grid-cols-[2rem_minmax(0,1fr)] md:grid-cols-[2rem_11rem_3.5rem_11rem_minmax(0,1fr)]';

export const floorLabel = (floor: number) => `Leader’s Floor: ${floor}`;
export const segmentLabel = (s: { label: string; points: number }) =>
  `${s.label}: ${s.points} ${s.points === 1 ? 'pt' : 'pts'}`;

/**
 * The track itself stays in the accessibility tree so the best-possible part can take focus and name its value;
 * the segments and the phone floor mark are decorative there (the row's sentence says them). The segments let
 * the pointer through their empty area, so hovering past the current total reaches the best-possible part.
 */
function barTrack(bar: BarView, floorPct: number | null, floor: number | null): HTMLElement {
  const segments = el('span', {
    class: 'pointer-events-none absolute inset-0 flex overflow-hidden rounded-md',
    'aria-hidden': 'true',
    'data-bar-segments': '',
  });
  for (const s of bar.segments) {
    segments.append(
      el('span', {
        class:
          'pointer-events-auto h-full shrink-0 border-r border-white/20 bg-brand-primary text-fixed-white last:rounded-r-md last:border-r-0 motion-safe:transition-[width] motion-safe:duration-150',
        style: `width:${s.pct.toFixed(2)}%`,
        'data-tip': segmentLabel(s),
        'data-bar-segment': '',
      }),
    );
  }
  return el(
    'span',
    {
      class: 'relative col-start-2 h-4 rounded-md bg-white/5 md:col-start-auto',
      'data-bar-track': '',
    },
    el('span', {
      class:
        'absolute inset-y-0 left-0 rounded-md bg-brand-primary/20 motion-safe:transition-[width] motion-safe:duration-150',
      style: `width:${bar.bestPct.toFixed(2)}%`,
      tabindex: '0',
      role: 'img',
      'aria-label': bar.bestLabel,
      'data-tip': bar.bestLabel,
      'data-bar-best': '',
    }),
    segments,
    // Phones only: the bars wrap under the name line there, so each bar carries its own floor mark.
    floorPct === null || floor === null
      ? null
      : el('span', {
          class: 'absolute -inset-y-1 w-0.5 bg-brand-gold md:hidden',
          style: `left:${floorPct.toFixed(2)}%`,
          'aria-hidden': 'true',
          'data-tip': floorLabel(floor),
        }),
  );
}

function barRow(bar: BarView, floorPct: number | null, floor: number | null): HTMLElement {
  return el(
    'li',
    {
      class: `grid ${ROW_GRID} items-center gap-x-3 gap-y-1`,
      'data-bar': bar.key,
      'data-testid': 'contention-bar',
    },
    el('span', { class: 'sr-only', 'data-bar-text': '' }, bar.ariaLabel),
    el('span', { class: 'text-right font-display text-xl', 'aria-hidden': 'true' }, String(bar.position)),
    // One line on a phone; at desktop md:contents makes name, Pts and status their own grid columns.
    el(
      'span',
      { class: 'flex min-w-0 items-center gap-2 md:contents', 'aria-hidden': 'true' },
      el('span', { class: 'min-w-0 flex-1 truncate' }, bar.name),
      el(
        'span',
        { class: 'text-right text-sm font-semibold tabular-nums', 'data-bar-points': '' },
        bar.points,
      ),
      chip(bar.chip.label, bar.chip.tone),
    ),
    barTrack(bar, floorPct, floor),
  );
}

/** The one Leader’s Floor line, laid over the bar column of every row. */
function floorOverlay(floorPct: number, floor: number): HTMLElement {
  return el(
    'div',
    {
      class: `pointer-events-none absolute inset-0 hidden grid-rows-1 gap-x-3 md:grid ${ROW_GRID}`,
      'data-floor-overlay': '',
    },
    // Spacers for Pos, name, Pts and status, so the line lands in the bar column.
    el('span'),
    el('span'),
    el('span'),
    el('span'),
    el(
      'span',
      { class: 'relative' },
      el(
        'span',
        {
          class: 'pointer-events-auto absolute -inset-y-1 w-3 -translate-x-1/2',
          style: `left:${floorPct.toFixed(2)}%`,
          role: 'img',
          'aria-label': floorLabel(floor),
          'data-tip': floorLabel(floor),
          'data-floor-line': '',
        },
        el('span', { class: 'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-brand-gold' }),
      ),
    ),
  );
}

/**
 * One tooltip for every data-tip in the bars: a segment's race and points, the floor's value, or the best
 * possible. Keyboard focus shows it too, so the focusable best-possible part works without a pointer.
 */
function bindTooltip(wrap: HTMLElement, tip: HTMLElement): void {
  const show = (e: Event) => {
    const target = (e.target as HTMLElement).closest?.<HTMLElement>('[data-tip]');
    if (!target || !wrap.contains(target)) return;
    const box = wrap.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    tip.textContent = target.getAttribute('data-tip') ?? '';
    tip.setAttribute(
      'style',
      `left:${(rect.left + rect.width / 2 - box.left).toFixed(0)}px;top:${(rect.top - box.top - 30).toFixed(0)}px;transform:translateX(-50%)`,
    );
    tip.classList.remove('hidden');
  };
  wrap.addEventListener('pointerover', show);
  wrap.addEventListener('focusin', show);
  wrap.addEventListener('pointerout', (e) => {
    const next = (e as PointerEvent).relatedTarget as HTMLElement | null;
    if (!next?.closest?.('[data-tip]')) tip.classList.add('hidden');
  });
  wrap.addEventListener('focusout', () => tip.classList.add('hidden'));
}

export function contendersSection(state: CalcState, snapshot: Snapshot): HTMLElement {
  const { floor, floorPct } = contendersFloor(state, snapshot);
  const list = el('ol', { class: 'space-y-2', 'data-contention-bars': '' });
  for (const bar of barViews(state, snapshot)) list.append(barRow(bar, floorPct, floor));

  const tip = el('div', {
    class:
      'pointer-events-none absolute z-20 hidden whitespace-nowrap rounded-md border border-white/10 bg-brand-ink px-2 py-1 text-xs text-white',
    role: 'tooltip',
    'data-bar-tip': '',
  });
  const wrap = el(
    'div',
    { class: 'relative mt-4', 'data-bars-wrap': '' },
    list,
    floorPct === null || floor === null ? null : floorOverlay(floorPct, floor),
    tip,
  );
  bindTooltip(wrap, tip);

  const legend = el(
    'p',
    {
      class: 'mt-3 flex flex-wrap gap-4 text-xs text-white/60',
      'aria-hidden': 'true',
      'data-contenders-legend': '',
    },
    el(
      'span',
      { class: 'flex items-center gap-1.5' },
      el('span', { class: 'inline-block h-2.5 w-4 rounded-sm bg-brand-primary text-fixed-white' }),
      'Current Points',
    ),
    el(
      'span',
      { class: 'flex items-center gap-1.5' },
      el('span', { class: 'inline-block h-2.5 w-4 rounded-sm bg-brand-primary/20' }),
      'Best Possible',
    ),
    floor === null
      ? null
      : el(
          'span',
          { class: 'flex items-center gap-1.5' },
          el('span', { class: 'inline-block h-3 w-0.5 bg-brand-gold' }),
          'Leader’s Floor',
        ),
  );

  return el(
    'section',
    { class: 'mt-8', 'aria-labelledby': 'points-contenders-heading', 'data-contenders': '' },
    el(
      'h2',
      { id: 'points-contenders-heading', class: 'font-display text-2xl sm:text-3xl' },
      'Points Contenders',
    ),
    legend,
    wrap,
  );
}

/** The Scenario Editor's table for the draft's edits. */
export function scenarioMatrix(draft: CalcState, snapshot: Snapshot): HTMLElement {
  return matrixElement(draft.season, matrixRows(draft, snapshot));
}
