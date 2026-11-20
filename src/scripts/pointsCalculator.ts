/**
 * Points Contenders (FR2-FR4, FR8; BR3.1-BR3.13): reads the CalculatorSeason the advanced-stats/points
 * fragment embeds, draws the bars, and runs the Scenario Editor opened from the filter card's button. The
 * editor changes a draft copy of the reader's edits; Save puts the draft on the bars, anything else drops it.
 * A Season or Championship change, a reload or leaving the page starts again with no edits, and the edits never
 * reach the address (FR2.8).
 */
import { editKey } from '../lib/calculator/engine';
import type { CalculatorEntrant, CalculatorRound } from '../lib/calculator/types';
import {
  cellEdits,
  createState,
  draftState,
  driverFieldSize,
  initialDraft,
  memberFieldSize,
  parseCalculatorSeason,
  recompute,
  resetEdits,
  saveDraft,
  setEdit,
  teamLines,
  undoEdit,
  type CalcState,
  type Draft,
  type Snapshot,
} from './pointsCalculatorModel';
import { contendersSection, scenarioMatrix } from './pointsCalculatorView';
import { openCellEditor, openScenarioEditor, openTeamEditor } from './pointsCalculatorEditor';

interface Controller {
  root: HTMLElement;
  body: HTMLElement;
  status: HTMLElement | null;
  state: CalcState;
  snapshot: Snapshot;
}

let current: Controller | null = null;

const OPEN_SELECTOR = '[data-scenario-editor-open]';

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

const cellSelector = (entrantKey: string, roundIndex: number) =>
  `[data-cell-entrant="${cssEscape(entrantKey)}"][data-cell-round="${roundIndex}"]`;

function render(c: Controller): void {
  c.snapshot = recompute(c.state);
  c.body.replaceChildren(contendersSection(c.state, c.snapshot));
}

/** The polite "Totals updated" status after Save. */
function announce(c: Controller, text = 'Totals updated'): void {
  if (!c.status) return;
  c.status.textContent = '';
  c.status.textContent = text;
}

function editorTitle(entrant: CalculatorEntrant, round: CalculatorRound): string {
  return `${entrant.name} · ${round.label}`;
}

/**
 * Opens the cell's editor over the Scenario Editor. Changes go to `draft` and `changed` redraws the table;
 * focus goes back to the cell in `container`.
 */
export function openCellFor(
  draft: CalcState,
  snapshot: Snapshot,
  container: HTMLElement,
  entrantKey: string,
  roundIndex: number,
  changed: (focusSelector?: string) => void,
): void {
  const { season } = draft;
  const round = season.rounds[roundIndex - 1];
  const entrant = season.entrants.find((e) => e.key === entrantKey);
  if (!round || round.state === 'special' || !entrant) return;
  const selector = cellSelector(entrantKey, roundIndex);
  const returnFocus = () => container.querySelector<HTMLElement>(selector);

  if (season.isTeam) {
    const fieldSize = memberFieldSize(round);
    const drafts = new Map<string, Draft>();
    for (const edit of cellEdits(draft, entrantKey, roundIndex)) {
      if (edit.memberKey) drafts.set(edit.memberKey, initialDraft(round, null, edit, fieldSize));
    }
    openTeamEditor({
      title: editorTitle(entrant, round),
      round,
      entrantKey,
      fieldSize,
      drafts,
      linesFor: (d) => teamLines(draft, snapshot, entrant, round, d),
      returnFocus,
      onApply: (edits) => {
        for (const edit of edits) setEdit(draft, edit);
        changed(selector);
      },
      onUndoMember: (memberKey) => {
        undoEdit(draft, { entrantKey, memberKey, roundIndex });
        changed(selector);
      },
    });
    return;
  }

  const fieldSize = driverFieldSize(season);
  const existing = draft.edits.get(editKey({ entrantKey, roundIndex }));
  const row = snapshot.rows.find((r) => r.key === entrantKey);
  const start = initialDraft(round, row?.roundPoints[roundIndex - 1] ?? null, existing, fieldSize);
  openCellEditor({
    title: editorTitle(entrant, round),
    round,
    entrantKey,
    fieldSize,
    draft: start,
    canUndo: existing !== undefined,
    returnFocus,
    onApply: (edit) => {
      setEdit(draft, edit);
      changed(selector);
    },
    onUndo: () => {
      undoEdit(draft, { entrantKey, roundIndex });
      changed(selector);
    },
  });
}

/** The Scenario Editor over a draft of the page's edits. */
export function openScenario(c: Controller): void {
  const draft = draftState(c.state);
  let snapshot = recompute(draft);
  const editor = openScenarioEditor({
    content: () => scenarioMatrix(draft, snapshot),
    hasEdits: () => draft.edits.size > 0,
    onReset: () => {
      resetEdits(draft);
      snapshot = recompute(draft);
    },
    onSave: () => {
      saveDraft(c.state, draft);
      render(c);
      announce(c);
    },
    returnFocus: () => document.querySelector<HTMLElement>(OPEN_SELECTOR),
  });
  const changed = (focusSelector?: string) => {
    snapshot = recompute(draft);
    editor.refresh(focusSelector);
  };
  editor.body.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell-entrant][data-cell-round]');
    if (!cell || (cell as HTMLButtonElement).disabled) return;
    openCellFor(
      draft,
      snapshot,
      editor.body,
      cell.dataset.cellEntrant ?? '',
      Number(cell.dataset.cellRound),
      changed,
    );
  });
}

function initPointsCalculator(): void {
  const root = document.querySelector<HTMLElement>('[data-points-view] [data-points-calculator]');
  if (!root || root.dataset.calculatorBound) return;
  const season = parseCalculatorSeason(root.querySelector('#points-calculator-data')?.textContent);
  const body = root.querySelector<HTMLElement>('[data-calculator-body]');
  if (!season || !body) return;
  root.dataset.calculatorBound = 'true';
  const state = createState(season);
  const c: Controller = {
    root,
    body,
    status: root.querySelector<HTMLElement>('[data-calculator-status]'),
    state,
    snapshot: recompute(state),
  };
  current = c;
  render(c);
  const open = document.querySelector<HTMLButtonElement>(OPEN_SELECTOR);
  if (open) open.disabled = false;
}

let globalBound = false;

function bindGlobal(): void {
  if (globalBound) return;
  globalBound = true;
  // The button sits in the shell's filter card, so one listener serves every fragment load.
  document.addEventListener('click', (e) => {
    const open = (e.target as HTMLElement).closest<HTMLButtonElement>(OPEN_SELECTOR);
    const c = current;
    if (!open || open.disabled || !c || !c.root.isConnected) return;
    openScenario(c);
  });
}

if (typeof document !== 'undefined') {
  bindGlobal();
  initPointsCalculator();
  document.addEventListener('astro:page-load', initPointsCalculator);
}
