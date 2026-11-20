/**
 * The points calculator's markup (FR4, FR5; NFR6): the Points Contenders bars, the results matrix and the
 * Points Scenarios pickers, head-to-head table and verdict, built as elements from the view models in
 * pointsCalculatorModel.ts. Names are set as text, never as HTML. Colours come only from the theme tokens, so
 * both themes work; the bars animate only when the reader allows motion. Events are wired by
 * src/scripts/pointsCalculator.ts through the data attributes set here.
 */
import { editKey } from '../lib/calculator/engine';
import type { CalculatorSeason } from '../lib/calculator/types';
import {
  barViews,
  contendersHeader,
  driverFieldSize,
  headToHeadChoice,
  matrixRows,
  positionOptions,
  scenarioModel,
  scenarioRounds,
  type CalcState,
  type ChipTone,
  type MatrixRow,
  type Snapshot,
} from './pointsCalculatorModel';

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** One element: attributes (false, null and undefined are left off), then children (strings become text). */
export function el(tag: string, attrs: Attrs = {}, ...children: (Node | string | null | false)[]): HTMLElement {
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
    { class: `inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${CHIP_CLASS[tone]}` },
    label,
  );
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-white/15 bg-transparent px-3 text-sm text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5';
const SMALL_SELECT_CLASS =
  'h-[30px] rounded-md border border-white/15 bg-transparent px-1.5 text-xs text-white outline-none hover:bg-white/5 focus:border-brand-primary';

function option(value: string, label: string, selected: boolean): HTMLElement {
  return el('option', { value, selected, class: 'bg-brand-ink text-white' }, label);
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
  return state === 'future' ? 'border-white/20 focus:border-brand-primary' : 'border-white/10 focus:border-brand-primary';
}

/** FR2.5-FR2.9: Pos and name pinned, one column per round, Total and Status; every cell a button. */
export function matrixElement(season: CalculatorSeason, rows: MatrixRow[], captionText: string): HTMLElement {
  const head = el(
    'tr',
    { class: 'border-b border-white/10 text-xs uppercase tracking-wide text-white/60' },
    el('th', { scope: 'col', class: 'sticky left-0 z-10 bg-brand-ink px-2 py-2 text-right' }, 'Pos'),
    el('th', { scope: 'col', class: 'sticky left-10 z-10 bg-brand-ink px-2 py-2 text-left' }, season.isTeam ? 'Team' : 'Driver'),
    ...season.rounds.map((r) => el('th', { scope: 'col', class: 'px-1 py-2 text-center', title: r.label }, r.short)),
    el('th', { scope: 'col', class: 'px-2 py-2 text-right' }, 'Total'),
    el('th', { scope: 'col', class: 'px-2 py-2 text-left' }, 'Status'),
  );
  const body = el('tbody');
  for (const row of rows) {
    const tr = el(
      'tr',
      { class: 'border-b border-white/5 last:border-0' },
      el('td', { class: 'sticky left-0 z-10 bg-brand-ink px-2 py-1 text-right font-display text-base' }, String(row.position)),
      el('th', { scope: 'row', class: 'sticky left-10 z-10 max-w-[10rem] truncate bg-brand-ink px-2 py-1 text-left font-normal' }, row.name),
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
          ? el('span', { class: 'absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full bg-brand-gold', 'aria-hidden': 'true' })
          : null,
      );
      tr.append(el('td', { class: 'px-0.5 py-1 text-center' }, button));
    }
    tr.append(
      el('td', { class: 'px-2 py-1 text-right font-semibold tabular-nums', 'data-matrix-total': row.key }, String(row.total)),
      el('td', { class: 'px-2 py-1' }, chip(row.status.label, row.status.tone)),
    );
    body.append(tr);
  }
  return el(
    'div',
    { class: 'mt-3 overflow-x-auto rounded-xl border border-white/10', 'data-results-matrix': '' },
    el('table', { class: 'data-table w-full text-sm' }, el('caption', { class: 'px-3 py-2 text-left text-xs text-white/60' }, captionText), el('thead', {}, head), body),
  );
}

function matrixCaption(season: CalculatorSeason): string {
  return `${season.championshipLabel} championship, ${season.seasonName}: click a cell to change a position or type points.`;
}

// --- Points Contenders ------------------------------------------------------------------------------------

export function contendersSection(state: CalcState, snapshot: Snapshot): HTMLElement {
  const header = contendersHeader(state, snapshot);
  const bars = barViews(snapshot);
  const list = el('ol', { class: 'mt-4 space-y-2', 'data-contention-bars': '' });
  for (const bar of bars) {
    list.append(
      el(
        'li',
        {
          class: 'grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 md:grid-cols-[2rem_10rem_minmax(0,1fr)_auto]',
          'aria-label': bar.ariaLabel,
          'data-bar': bar.key,
          'data-testid': 'contention-bar',
        },
        el('span', { class: 'text-right font-display text-xl', 'aria-hidden': 'true' }, String(bar.position)),
        el('span', { class: 'truncate', 'aria-hidden': 'true' }, bar.name),
        el(
          'span',
          { class: 'relative col-span-2 h-4 rounded-md bg-white/5 md:col-span-1', 'aria-hidden': 'true' },
          el('span', {
            class: 'absolute inset-y-0 left-0 rounded-md bg-brand-primary/20 motion-safe:transition-[width] motion-safe:duration-150',
            style: `width:${bar.bestPct.toFixed(2)}%`,
          }),
          el('span', {
            class: 'absolute inset-y-0 left-0 rounded-md bg-brand-primary text-fixed-white motion-safe:transition-[width] motion-safe:duration-150',
            style: `width:${bar.countedPct.toFixed(2)}%`,
          }),
          header.floorPct === null
            ? null
            : el('span', { class: 'absolute -inset-y-1 w-0.5 bg-brand-gold', style: `left:${header.floorPct.toFixed(2)}%` }),
        ),
        el(
          'span',
          { class: 'col-span-2 flex items-center justify-end gap-2 text-sm tabular-nums md:col-span-1', 'aria-hidden': 'true' },
          el('span', { 'data-bar-numbers': '' }, bar.numbers),
          chip(bar.chip.label, bar.chip.tone),
        ),
      ),
    );
  }

  const legend = el(
    'p',
    { class: 'mt-3 flex flex-wrap gap-4 text-xs text-white/60', 'aria-hidden': 'true' },
    el('span', { class: 'flex items-center gap-1.5' }, el('span', { class: 'inline-block h-2.5 w-4 rounded-sm bg-brand-primary text-fixed-white' }), 'Counted points now'),
    el('span', { class: 'flex items-center gap-1.5' }, el('span', { class: 'inline-block h-2.5 w-4 rounded-sm bg-brand-primary/20' }), 'Best possible'),
    header.floor === null
      ? null
      : el('span', { class: 'flex items-center gap-1.5' }, el('span', { class: 'inline-block h-3 w-0.5 bg-brand-gold' }), `Leader’s floor ${header.floor}`),
  );

  const section = el(
    'section',
    { class: 'mt-8', 'aria-labelledby': 'points-contenders-heading', 'data-contenders': '' },
    el('h2', { id: 'points-contenders-heading', class: 'font-display text-2xl sm:text-3xl' }, 'Points Contenders'),
    el('p', { class: 'mt-1 text-sm text-white/60', 'data-contenders-summary': '' }, header.text),
    legend,
    list,
    el(
      'div',
      { class: 'mt-5 flex flex-wrap items-center gap-3' },
      el(
        'button',
        { type: 'button', class: 'btn btn-primary', 'aria-expanded': state.matrixOpen ? 'true' : 'false', 'data-toggle-matrix': '', 'data-testid': 'edit-results' },
        state.matrixOpen ? 'Hide results' : 'Edit results',
      ),
      el(
        'button',
        { type: 'button', class: 'btn', 'aria-expanded': state.matrixOpen ? 'true' : 'false', 'data-toggle-matrix': '', 'data-testid': 'show-as-table' },
        'Show as table',
      ),
      el('span', { class: 'text-xs text-white/60' }, 'Click a cell to change a position or type points.'),
    ),
  );
  if (state.matrixOpen) section.append(matrixElement(state.season, matrixRows(state, snapshot), matrixCaption(state.season)));
  return section;
}

// --- Points Scenarios -------------------------------------------------------------------------------------

export function scenariosSection(state: CalcState, snapshot: Snapshot): HTMLElement {
  const model = scenarioModel(state, snapshot);
  const section = el(
    'section',
    { class: 'mt-8', 'aria-labelledby': 'points-scenarios-heading', 'data-scenarios': '' },
    el('h2', { id: 'points-scenarios-heading', class: 'font-display text-2xl sm:text-3xl' }, 'Points Scenarios'),
  );
  const verdictBox = el(
    'p',
    {
      class: 'mt-4 border-l-2 border-brand-gold/70 bg-brand-gold/5 px-3 py-2 text-sm',
      role: 'status',
      'aria-live': 'polite',
      'data-verdict': '',
      'data-testid': 'scenario-verdict',
    },
    model.verdict,
  );

  if (!model.single && model.chaser && model.target) {
    const picker = (which: 'chaser' | 'target', label: string, current: string) =>
      el(
        'label',
        { class: 'flex flex-col gap-1.5 sm:w-60' },
        el('span', { class: 'text-xs font-semibold uppercase tracking-wide text-white/40' }, label),
        el(
          'select',
          { 'aria-label': label, class: SELECT_CLASS, 'data-scenario-pick': which, 'data-testid': `scenario-${which}` },
          ...model.options.map((o) => option(o.key, o.label, o.key === current)),
        ),
      );
    section.append(
      el(
        'div',
        { class: 'mt-4 flex flex-col gap-3 sm:flex-row sm:items-end' },
        picker('chaser', 'Chaser', model.chaser.key),
        el('span', { class: 'pb-2 text-center text-sm text-white/60' }, 'vs'),
        picker('target', 'Target', model.target.key),
      ),
      verdictBox,
      headToHeadTable(state, [model.chaser, model.target]),
    );
  } else {
    section.append(verdictBox);
  }

  section.append(
    el('h3', { class: 'mt-8 font-display text-xl' }, 'Results with these edits'),
    el(
      'div',
      { class: 'text-xs' },
      matrixElement(state.season, matrixRows(state, snapshot), matrixCaption(state.season)),
    ),
  );
  return section;
}

function headToHeadTable(state: CalcState, rows: { key: string; name: string; now: number; final: number }[]): HTMLElement {
  const rounds = scenarioRounds(state.season);
  const fieldSize = driverFieldSize(state.season);
  const head = el(
    'tr',
    { class: 'border-b border-white/10 text-xs uppercase tracking-wide text-white/60' },
    el('th', { scope: 'col', class: 'sticky left-0 z-10 bg-brand-ink px-2 py-2 text-left' }, state.season.isTeam ? 'Team' : 'Driver'),
    ...rounds.map((r) => el('th', { scope: 'col', class: 'px-1 py-2 text-center', title: r.label }, r.short)),
    el('th', { scope: 'col', class: 'px-2 py-2 text-right' }, 'Now'),
    el('th', { scope: 'col', class: 'px-2 py-2 text-right' }, 'Final'),
  );
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { class: 'border-b border-white/5 last:border-0' }, el('th', { scope: 'row', class: 'sticky left-0 z-10 bg-brand-ink px-2 py-1 text-left font-normal' }, row.name));
    for (const round of rounds) {
      let control: HTMLElement;
      if (round.state === 'special') {
        control = el('span', { class: 'text-white/60', title: 'No points table for this format' }, '—');
      } else if (state.season.isTeam) {
        // A team's round is set through its drivers, in the same editor as the matrix (FR2.9).
        const edited = state.edits.size > 0 && [...state.edits.values()].some((e) => e.entrantKey === row.key && e.roundIndex === round.index);
        control = el(
          'button',
          {
            type: 'button',
            class: `h-[30px] rounded-md border px-2 text-xs hover:bg-white/5 ${edited ? 'border-brand-gold/70' : 'border-dashed border-white/20 text-white/60'}`,
            'aria-label': `${row.name}, round ${round.index}: set the drivers’ results`,
            'data-cell-entrant': row.key,
            'data-cell-round': round.index,
          },
          edited ? 'Edited' : 'Set',
        );
      } else {
        const choice = headToHeadChoice(state, row.key, round.index);
        const typed = choice === 'pts' ? state.edits.get(editKey({ entrantKey: row.key, roundIndex: round.index }))?.points : undefined;
        control = el(
          'select',
          {
            class: SMALL_SELECT_CLASS,
            'aria-label': `${row.name}, round ${round.index} finishing position`,
            'data-h2h-entrant': row.key,
            'data-h2h-round': round.index,
          },
          option('', 'Set', choice === ''),
          ...positionOptions(round, fieldSize).map((o) => option(o.value, o.value === 'dns' ? 'DNS' : `P${o.value.slice(1)}`, o.value === choice)),
          choice === 'pts' ? option('pts', `${typed ?? 0} pts`, true) : null,
          option('type', 'Type points…', false),
        );
      }
      tr.append(el('td', { class: 'px-1 py-1 text-center' }, control));
    }
    tr.append(
      el('td', { class: 'px-2 py-1 text-right tabular-nums text-white/60' }, String(row.now)),
      el('td', { class: 'px-2 py-1 text-right font-semibold tabular-nums', 'data-h2h-final': row.key }, String(row.final)),
    );
    body.append(tr);
  }
  return el(
    'div',
    { class: 'mt-4 overflow-x-auto rounded-xl border border-white/10' },
    el('table', { class: 'data-table w-full text-sm' }, el('caption', { class: 'sr-only' }, 'Head to head over the rounds left'), el('thead', {}, head), body),
  );
}
