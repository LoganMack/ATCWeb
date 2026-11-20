/**
 * Points Contenders and Points Scenarios (FR2-FR5, FR8; BR3.1-BR3.13): reads the CalculatorSeason the
 * advanced-stats/points fragment embeds, keeps one set of reader edits for both views, and recomputes and
 * redraws everything after each change. Switching between the two views happens in the page, so the edits
 * survive (the address's `view` is updated with replaceState); any other View, a Season or Championship change,
 * a reload or leaving the page starts again with no edits, and the edits never reach the address (FR2.8).
 */
import { editKey } from '../lib/calculator/engine';
import type { CalculatorEntrant, CalculatorRound } from '../lib/calculator/types';
import {
  cellEdits,
  createState,
  draftEdit,
  driverFieldSize,
  initialDraft,
  memberFieldSize,
  parseCalculatorSeason,
  pick,
  recompute,
  resetEdits,
  setEdit,
  teamLines,
  undoEdit,
  type CalcState,
  type CalculatorView,
  type Draft,
  type Snapshot,
} from './pointsCalculatorModel';
import { contendersSection, scenariosSection } from './pointsCalculatorView';
import { openCellEditor, openTeamEditor } from './pointsCalculatorEditor';

interface Controller {
  root: HTMLElement;
  body: HTMLElement;
  status: HTMLElement | null;
  state: CalcState;
  snapshot: Snapshot;
}

let current: Controller | null = null;

const isCalculatorView = (value: string | undefined): value is CalculatorView =>
  value === 'contenders' || value === 'scenarios';

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

const cellSelector = (entrantKey: string, roundIndex: number) =>
  `[data-cell-entrant="${cssEscape(entrantKey)}"][data-cell-round="${roundIndex}"]`;

function render(c: Controller, focusSelector?: string): void {
  c.snapshot = recompute(c.state);
  const section = c.state.view === 'contenders' ? contendersSection(c.state, c.snapshot) : scenariosSection(c.state, c.snapshot);
  c.body.replaceChildren(section);
  const reset = document.querySelector<HTMLButtonElement>('[data-calculator-reset]');
  if (reset) reset.disabled = c.state.edits.size === 0;
  if (focusSelector) c.body.querySelector<HTMLElement>(focusSelector)?.focus();
}

/** The polite "Totals updated" status after Apply, Undo and Reset. */
function announce(c: Controller, text = 'Totals updated'): void {
  if (!c.status) return;
  c.status.textContent = '';
  c.status.textContent = text;
}

function changed(c: Controller, focusSelector?: string): void {
  render(c, focusSelector);
  announce(c);
}

function editorTitle(entrant: CalculatorEntrant, round: CalculatorRound): string {
  return `${entrant.name} · ${round.label}`;
}

function openEditor(c: Controller, entrantKey: string, roundIndex: number, prefer?: Partial<Draft>): void {
  const { season } = c.state;
  const round = season.rounds[roundIndex - 1];
  const entrant = season.entrants.find((e) => e.key === entrantKey);
  if (!round || round.state === 'special' || !entrant) return;
  const selector = cellSelector(entrantKey, roundIndex);
  const returnFocus = () => c.body.querySelector<HTMLElement>(selector);

  if (season.isTeam) {
    const fieldSize = memberFieldSize(round);
    const drafts = new Map<string, Draft>();
    for (const edit of cellEdits(c.state, entrantKey, roundIndex)) {
      if (edit.memberKey) drafts.set(edit.memberKey, initialDraft(round, null, edit, fieldSize));
    }
    openTeamEditor({
      title: editorTitle(entrant, round),
      round,
      entrantKey,
      fieldSize,
      drafts,
      linesFor: (d) => teamLines(c.state, c.snapshot, entrant, round, d),
      returnFocus,
      onApply: (edits) => {
        for (const edit of edits) setEdit(c.state, edit);
        changed(c);
      },
      onUndoMember: (memberKey) => {
        undoEdit(c.state, { entrantKey, memberKey, roundIndex });
        changed(c);
      },
    });
    return;
  }

  const fieldSize = driverFieldSize(season);
  const existing = c.state.edits.get(editKey({ entrantKey, roundIndex }));
  const row = c.snapshot.rows.find((r) => r.key === entrantKey);
  const draft = { ...initialDraft(round, row?.roundPoints[roundIndex - 1] ?? null, existing, fieldSize), ...prefer };
  openCellEditor({
    title: editorTitle(entrant, round),
    round,
    entrantKey,
    fieldSize,
    draft,
    canUndo: existing !== undefined,
    returnFocus,
    onApply: (edit) => {
      setEdit(c.state, edit);
      changed(c);
    },
    onUndo: () => {
      undoEdit(c.state, { entrantKey, roundIndex });
      changed(c);
    },
  });
}

function onClick(c: Controller, e: Event): void {
  const target = e.target as HTMLElement;
  const cell = target.closest<HTMLElement>('[data-cell-entrant][data-cell-round]');
  if (cell && !(cell as HTMLButtonElement).disabled) {
    openEditor(c, cell.dataset.cellEntrant ?? '', Number(cell.dataset.cellRound));
    return;
  }
  const toggle = target.closest<HTMLElement>('[data-toggle-matrix]');
  if (toggle) {
    c.state.matrixOpen = !c.state.matrixOpen;
    render(c, `[data-testid="${toggle.dataset.testid}"]`);
  }
}

function onChange(c: Controller, e: Event): void {
  const select = e.target as HTMLSelectElement;
  if (select.dataset.scenarioPick === 'chaser' || select.dataset.scenarioPick === 'target') {
    pick(c.state, select.dataset.scenarioPick, select.value);
    render(c, `[data-scenario-pick="${select.dataset.scenarioPick}"]`);
    return;
  }
  const entrantKey = select.dataset.h2hEntrant;
  const roundIndex = Number(select.dataset.h2hRound);
  if (!entrantKey || !roundIndex) return;
  const round = c.state.season.rounds[roundIndex - 1];
  const focus = `[data-h2h-entrant="${cssEscape(entrantKey)}"][data-h2h-round="${roundIndex}"]`;
  if (select.value === 'type') {
    render(c);
    openEditor(c, entrantKey, roundIndex, { typed: true });
    return;
  }
  if (select.value === '') {
    undoEdit(c.state, { entrantKey, roundIndex });
  } else if (select.value !== 'pts' && round) {
    const edit = draftEdit(round, { typed: false, choice: select.value, text: '' }, { entrantKey });
    if (edit) setEdit(c.state, edit);
  }
  changed(c, focus);
}

/** Swaps Contenders and Scenarios in the page and keeps the address and the filters' links in step. */
export function switchView(c: Controller, view: CalculatorView): void {
  c.state.view = view;
  c.root.closest('[data-points-view]')?.setAttribute('data-points-view', view);
  const url = new URL(location.href);
  url.searchParams.set('view', view);
  history.replaceState(history.state, '', url.pathname + url.search);
  document.querySelectorAll<HTMLOptionElement>('select[data-calculator-filter] option').forEach((option) => {
    const href = new URL(option.value, location.origin);
    href.searchParams.set('view', view);
    option.value = href.pathname + href.search;
  });
  render(c);
}

function initPointsCalculator(): void {
  const root = document.querySelector<HTMLElement>('[data-points-view] [data-points-calculator]');
  if (!root || root.dataset.calculatorBound) return;
  const season = parseCalculatorSeason(root.querySelector('#points-calculator-data')?.textContent);
  const body = root.querySelector<HTMLElement>('[data-calculator-body]');
  if (!season || !body) return;
  root.dataset.calculatorBound = 'true';
  const view = root.closest<HTMLElement>('[data-points-view]')?.dataset.pointsView;
  const state = createState(season, isCalculatorView(view) ? view : 'contenders');
  const c: Controller = {
    root,
    body,
    status: root.querySelector<HTMLElement>('[data-calculator-status]'),
    state,
    snapshot: recompute(state),
  };
  current = c;
  body.addEventListener('click', (e) => onClick(c, e));
  body.addEventListener('change', (e) => onChange(c, e));
  render(c);
}

let globalBound = false;

function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener('change', (e) => {
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-calculator-view-select]');
    if (!select) return;
    const view = select.selectedOptions[0]?.dataset.view;
    const c = current;
    if (c && c.root.isConnected && isCalculatorView(view)) switchView(c, view);
    else location.assign(select.value);
  });
  document.addEventListener('click', (e) => {
    const reset = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-calculator-reset]');
    const c = current;
    if (!reset || !c || !c.root.isConnected) return;
    resetEdits(c.state);
    changed(c);
  });
}

if (typeof document !== 'undefined') {
  bindGlobal();
  initPointsCalculator();
  document.addEventListener('astro:page-load', initPointsCalculator);
}
