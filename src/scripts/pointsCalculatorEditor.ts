/**
 * The points calculator's cell editors (FR2.5, FR2.9; BR3.10; NFR6): CellEditor for a driver's round and
 * TeamCellEditor for a team's round, edited through its drivers. Both are native modal dialogs, so focus stays
 * inside while open and Escape closes them; focus then returns to the cell that opened them. Typed points must
 * be a whole number from 0 to 999, or Apply stays disabled.
 */
import type { CalculatorRound, Edit } from '../lib/calculator/types';
import {
  draftEdit,
  positionOptions,
  TYPED_POINTS_HINT,
  type Draft,
  type TeamLine,
} from './pointsCalculatorModel';
import { el } from './pointsCalculatorView';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-white/15 bg-transparent px-3 text-sm text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5';
const INPUT_CLASS =
  'h-9 w-28 rounded-md border border-white/15 bg-transparent px-3 text-sm text-white outline-none focus:border-brand-primary';

let editorCount = 0;

function dialogShell(title: string, returnFocus: () => HTMLElement | null): { dialog: HTMLDialogElement; body: HTMLElement; actions: HTMLElement } {
  const id = `calculator-editor-title-${++editorCount}`;
  const body = el('div', { class: 'mt-4 space-y-3' });
  const actions = el('div', { class: 'mt-5 flex flex-wrap justify-end gap-2' });
  const dialog = el(
    'dialog',
    {
      'aria-labelledby': id,
      class: 'w-full max-w-md rounded-xl border border-white/10 bg-brand-ink p-5 text-white backdrop:bg-black/60',
      'data-calculator-editor': '',
    },
    el('h3', { id, class: 'font-display text-xl' }, title),
    body,
    actions,
  ) as HTMLDialogElement;
  dialog.addEventListener('close', () => {
    dialog.remove();
    returnFocus()?.focus();
  });
  return { dialog, body, actions };
}

/** One position-or-points control: the select, the "Type points instead" switch and the points input. */
function draftControl(
  round: CalculatorRound,
  fieldSize: number,
  draft: Draft,
  label: string,
  onChange: (draft: Draft) => void,
  withKeep = false,
): { root: HTMLElement; focusTarget: HTMLElement } {
  const select = el(
    'select',
    { class: SELECT_CLASS, 'aria-label': `${label} finishing position`, 'data-editor-position': '' },
    withKeep ? el('option', { value: '', class: 'bg-brand-ink text-white' }, 'No change') : null,
    ...positionOptions(round, fieldSize).map((o) =>
      el('option', { value: o.value, selected: !draft.typed && o.value === draft.choice, class: 'bg-brand-ink text-white' }, o.label),
    ),
  ) as HTMLSelectElement;
  if (withKeep && !draft.typed && draft.choice === '') select.value = '';
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    class: INPUT_CLASS,
    'aria-label': `${label} points`,
    value: draft.text,
    'data-editor-points': '',
  }) as HTMLInputElement;
  const toggle = el('input', { type: 'checkbox', checked: draft.typed, 'data-editor-typed': '' }) as HTMLInputElement;
  const hint = el('p', { class: 'text-xs text-brand-pink', 'aria-live': 'polite', 'data-editor-hint': '' });
  const current: Draft = { ...draft };
  const sync = () => {
    select.hidden = current.typed;
    input.hidden = !current.typed;
    const invalid = current.typed && draftEdit(round, current, { entrantKey: '' }) === null;
    hint.textContent = invalid ? TYPED_POINTS_HINT : '';
  };
  select.addEventListener('change', () => {
    current.choice = select.value;
    onChange({ ...current });
  });
  input.addEventListener('input', () => {
    current.text = input.value;
    sync();
    onChange({ ...current });
  });
  toggle.addEventListener('change', () => {
    current.typed = toggle.checked;
    if (!current.typed && withKeep && select.value === '') current.choice = '';
    sync();
    onChange({ ...current });
    (current.typed ? input : select).focus();
  });
  sync();
  const root = el(
    'div',
    { class: 'space-y-2' },
    el('div', { class: 'flex flex-wrap items-center gap-2' }, select, input),
    el('label', { class: 'flex items-center gap-2 text-sm text-white/80' }, toggle, 'Type points instead'),
    hint,
  );
  return { root, focusTarget: draft.typed ? input : select };
}

export interface CellEditorOptions {
  title: string;
  round: CalculatorRound;
  entrantKey: string;
  fieldSize: number;
  draft: Draft;
  canUndo: boolean;
  returnFocus: () => HTMLElement | null;
  onApply: (edit: Edit) => void;
  onUndo: () => void;
}

/** CellEditor: one driver's round. */
export function openCellEditor(o: CellEditorOptions): HTMLDialogElement {
  const { dialog, body, actions } = dialogShell(o.title, o.returnFocus);
  let draft = o.draft;
  const apply = el('button', { type: 'button', class: 'btn btn-primary', 'data-editor-apply': '' }, 'Apply') as HTMLButtonElement;
  const refresh = () => {
    apply.disabled = draftEdit(o.round, draft, { entrantKey: o.entrantKey }) === null;
  };
  const control = draftControl(o.round, o.fieldSize, draft, o.title, (next) => {
    draft = next;
    refresh();
  });
  body.append(control.root);
  apply.addEventListener('click', () => {
    const edit = draftEdit(o.round, draft, { entrantKey: o.entrantKey });
    if (!edit) return;
    o.onApply(edit);
    dialog.close();
  });
  actions.append(apply);
  if (o.canUndo) {
    const undo = el('button', { type: 'button', class: 'btn', 'data-editor-undo': '' }, 'Undo cell');
    undo.addEventListener('click', () => {
      o.onUndo();
      dialog.close();
    });
    actions.append(undo);
  }
  const close = el('button', { type: 'button', class: 'btn btn-neutral', 'data-editor-close': '' }, 'Close');
  close.addEventListener('click', () => dialog.close());
  actions.append(close);
  refresh();
  document.body.append(dialog);
  dialog.showModal();
  control.focusTarget.focus();
  return dialog;
}

export interface TeamEditorOptions {
  title: string;
  round: CalculatorRound;
  entrantKey: string;
  fieldSize: number;
  /** Starting drafts by member key (edited members only). */
  drafts: Map<string, Draft>;
  /** The lines, counting drivers and total for the given drafts (pointsCalculatorModel.teamLines). */
  linesFor: (drafts: ReadonlyMap<string, Draft>) => { lines: TeamLine[]; total: number | null; valid: boolean };
  returnFocus: () => HTMLElement | null;
  onApply: (edits: Edit[]) => void;
  onUndoMember: (memberKey: string) => void;
}

const racesText = (races: (number | null)[] | null) =>
  races === null ? 'did not race' : `${races.reduce<number>((s, p) => s + (p ?? 0), 0)} pts`;

/** TeamCellEditor: the team's drivers for one round; the two counting drivers and the total update live. */
export function openTeamEditor(o: TeamEditorOptions): HTMLDialogElement {
  const { dialog, body, actions } = dialogShell(o.title, o.returnFocus);
  const drafts = new Map(o.drafts);
  const apply = el('button', { type: 'button', class: 'btn btn-primary', 'data-editor-apply': '' }, 'Apply') as HTMLButtonElement;
  const total = el('p', { class: 'text-sm font-semibold', 'aria-live': 'polite', 'data-team-total': '' });
  const tags = new Map<string, HTMLElement>();
  const values = new Map<string, HTMLElement>();
  let focusTarget: HTMLElement | null = null;

  const refresh = () => {
    const model = o.linesFor(drafts);
    for (const line of model.lines) {
      tags.get(line.memberKey)!.textContent = line.counts ? 'counts' : '';
      values.get(line.memberKey)!.textContent = racesText(line.races);
    }
    total.textContent = `Team round total: ${model.total ?? 0}`;
    apply.disabled = !model.valid;
  };

  const initial = o.linesFor(drafts);
  for (const line of initial.lines) {
    const start = drafts.get(line.memberKey) ?? { typed: false, choice: '', text: '' };
    const control = draftControl(
      o.round,
      o.fieldSize,
      start,
      `${line.name}, ${o.round.short}`,
      (next) => {
        if (!next.typed && next.choice === '') drafts.delete(line.memberKey);
        else drafts.set(line.memberKey, next);
        refresh();
      },
      true,
    );
    focusTarget ??= control.focusTarget;
    const tag = el('span', { class: 'ml-2 rounded-full border border-brand-gold/70 px-1.5 text-[10px] text-brand-gold empty:hidden' });
    const value = el('span', { class: 'ml-2 text-xs text-white/60' });
    tags.set(line.memberKey, tag);
    values.set(line.memberKey, value);
    const header = el(
      'div',
      { class: 'flex items-center justify-between gap-2' },
      el('span', {}, el('span', { class: 'font-semibold' }, line.name), value, tag),
      line.edited
        ? el('span', { class: 'h-[5px] w-[5px] rounded-full bg-brand-gold', 'aria-hidden': 'true' })
        : null,
    );
    const box = el(
      'div',
      { class: `rounded-md border p-2 ${line.edited ? 'border-brand-gold/70' : 'border-white/10'}`, 'data-team-line': line.memberKey },
      header,
      control.root,
    );
    if (line.edited) {
      const undo = el('button', { type: 'button', class: 'btn btn-sm mt-1', 'data-editor-undo-member': line.memberKey }, 'Undo driver');
      undo.addEventListener('click', () => {
        o.onUndoMember(line.memberKey);
        dialog.close();
      });
      box.append(undo);
    }
    body.append(box);
  }
  if (initial.lines.length === 0) body.append(el('p', { class: 'text-sm text-white/60' }, 'No drivers have raced for this team yet.'));
  body.append(total);

  apply.addEventListener('click', () => {
    const edits: Edit[] = [];
    for (const [memberKey, draft] of drafts) {
      const edit = draftEdit(o.round, draft, { entrantKey: o.entrantKey, memberKey });
      if (!edit) return;
      edits.push(edit);
    }
    o.onApply(edits);
    dialog.close();
  });
  const close = el('button', { type: 'button', class: 'btn btn-neutral', 'data-editor-close': '' }, 'Close');
  close.addEventListener('click', () => dialog.close());
  actions.append(apply, close);
  refresh();
  document.body.append(dialog);
  dialog.showModal();
  (focusTarget ?? close).focus();
  return dialog;
}
