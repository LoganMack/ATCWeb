/**
 * The appeal cards' Close Appeal and Add/Edit Comment popups (appeals U1; BR1.2, BR2.2, BR3.1), filled from
 * each button's JSON. Save stays disabled until the input would pass; the server and database check again.
 * Close Appeal uses data-decide-appeal-*, since data-close-appeal-dialog marks Submit Appeal's Cancel.
 * Binds once on astro:page-load with delegated listeners, so a reloaded fragment needs no rebinding.
 */

export const APPEAL_TEXT_MAX = 4000;

/** What a Close Appeal button carries (fragment.astro). */
export interface CloseAppealData {
  appeal_id: string;
  label: string;
  /** The penalty as it stands, one line. */
  summary: string;
  time: number;
  points: number;
  licence: number;
  isWarning: boolean;
}

/** What an Add/Edit Comment button carries. */
export interface AppealCommentData {
  appeal_id: string;
  label: string;
  /** The steward's current comment, or '' for Add Comment. */
  body: string;
}

/** Characters as the database counts them (char_length), so an emoji counts once. */
export function textLength(text: string): number {
  return [...text].length;
}

/** "12 / 4,000" under a comment box. */
export function counterText(text: string, max = APPEAL_TEXT_MAX): string {
  return `${textLength(text).toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`;
}

/** Why the comment can't be saved yet, or null when it can (1 to 4,000 characters after trimming). */
export function appealTextProblem(text: string, max = APPEAL_TEXT_MAX): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'Write a comment first.';
  if (textLength(trimmed) > max) return `A comment can be at most ${max.toLocaleString('en-US')} characters.`;
  return null;
}

/** Why the Close Appeal values can't be saved yet, or null when they can (BR3.1, as parseCloseAppealForm). */
export function closeAppealProblem(values: {
  time: string;
  points: string;
  licence: string;
  comment: string;
}): string | null {
  if (!/^\d+(\.\d{1,3})?$/.test(values.time.trim()))
    return 'The time penalty must be 0 or more seconds, with at most 3 decimals.';
  if (!/^\d+$/.test(values.points.trim())) return 'The points penalty must be a whole number of 0 or more.';
  if (!/^\d+$/.test(values.licence.trim())) return 'Penalty points must be a whole number of 0 or more.';
  return appealTextProblem(values.comment);
}

function parseData<T>(raw: string | undefined): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function field<T extends HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function openCloseDialog(dialog: HTMLDialogElement, data: CloseAppealData): void {
  const set = (selector: string, value: string) => {
    const input = field<HTMLInputElement>(dialog, selector);
    if (input) input.value = value;
  };
  set('[data-decide-appeal-id]', data.appeal_id);
  set('[data-decide-appeal-time]', String(data.time));
  set('[data-decide-appeal-points]', String(data.points));
  set('[data-decide-appeal-licence]', String(data.licence));
  const warning = field<HTMLInputElement>(dialog, '[data-decide-appeal-warning]');
  if (warning) warning.checked = data.isWarning;
  const label = field<HTMLElement>(dialog, '[data-decide-appeal-label]');
  if (label) label.textContent = data.label;
  const summary = field<HTMLElement>(dialog, '[data-decide-appeal-summary]');
  if (summary) summary.textContent = data.summary;
  set('[data-decide-appeal-comment]', '');
  syncCloseDialog(dialog);
  dialog.showModal();
  field<HTMLTextAreaElement>(dialog, '[data-decide-appeal-comment]')?.focus();
}

function syncCloseDialog(dialog: HTMLDialogElement): void {
  const value = (selector: string) =>
    field<HTMLInputElement | HTMLTextAreaElement>(dialog, selector)?.value ?? '';
  const comment = value('[data-decide-appeal-comment]');
  const counter = field<HTMLElement>(dialog, '[data-decide-appeal-counter]');
  if (counter) counter.textContent = counterText(comment);
  const problem = closeAppealProblem({
    time: value('[data-decide-appeal-time]'),
    points: value('[data-decide-appeal-points]'),
    licence: value('[data-decide-appeal-licence]'),
    comment,
  });
  const submit = field<HTMLButtonElement>(dialog, '[data-decide-appeal-submit]');
  if (submit) submit.disabled = problem !== null;
}

function openCommentDialog(dialog: HTMLDialogElement, data: AppealCommentData): void {
  const id = field<HTMLInputElement>(dialog, '[data-appeal-comment-id]');
  if (id) id.value = data.appeal_id;
  const label = field<HTMLElement>(dialog, '[data-appeal-comment-label]');
  if (label) label.textContent = data.label;
  const heading = field<HTMLElement>(dialog, '[data-appeal-comment-heading]');
  if (heading) heading.textContent = data.body ? 'Edit Comment' : 'Add Comment';
  const body = field<HTMLTextAreaElement>(dialog, '[data-appeal-comment-body]');
  if (body) body.value = data.body;
  syncCommentDialog(dialog);
  dialog.showModal();
  body?.focus();
}

function syncCommentDialog(dialog: HTMLDialogElement): void {
  const text = field<HTMLTextAreaElement>(dialog, '[data-appeal-comment-body]')?.value ?? '';
  const counter = field<HTMLElement>(dialog, '[data-appeal-comment-counter]');
  if (counter) counter.textContent = counterText(text);
  const submit = field<HTMLButtonElement>(dialog, '[data-appeal-comment-submit]');
  if (submit) submit.disabled = appealTextProblem(text) !== null;
}

let bound = false;

function initAppealDialogs(): void {
  if (bound) return;
  bound = true;
  const closeDialog = () => document.querySelector<HTMLDialogElement>('[data-decide-appeal-dialog]');
  const commentDialog = () => document.querySelector<HTMLDialogElement>('[data-appeal-comment-dialog]');

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const closeButton = target.closest<HTMLElement>('[data-open-decide-appeal]');
    if (closeButton) {
      const dialog = closeDialog();
      const data = parseData<CloseAppealData>(closeButton.dataset.decideAppeal);
      if (dialog && data) openCloseDialog(dialog, data);
      return;
    }
    const commentButton = target.closest<HTMLElement>('[data-open-appeal-comment]');
    if (commentButton) {
      const dialog = commentDialog();
      const data = parseData<AppealCommentData>(commentButton.dataset.appealComment);
      if (dialog && data) openCommentDialog(dialog, data);
      return;
    }
    // The ✕ and Cancel buttons, and a click on the backdrop (the <dialog> itself, outside its form).
    const dismiss = target.closest<HTMLElement>(
      '[data-decide-appeal-dismiss], [data-appeal-comment-dismiss]',
    );
    if (dismiss) {
      dismiss.closest('dialog')?.close();
      return;
    }
    if (target instanceof HTMLDialogElement && (target === closeDialog() || target === commentDialog()))
      target.close();
  });

  document.addEventListener('input', (event) => {
    const target = event.target as Element | null;
    const dialog = target?.closest('dialog');
    if (!(dialog instanceof HTMLDialogElement)) return;
    if (dialog.matches('[data-decide-appeal-dialog]')) syncCloseDialog(dialog);
    else if (dialog.matches('[data-appeal-comment-dialog]')) syncCommentDialog(dialog);
  });
}

// Guarded so the tests can import the helpers in Node, where there is no document.
if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initAppealDialogs);
