// The own profile's Incident Management tab (U5; BR11.5, BR11.8, BR11.10, BR11.14; contract C4), imported by
// src/pages/drivers/[id].astro only. Add Comment and Submit Appeal open their popups (rendered after the
// profile form), which post in place through postInPlace and update the row on success; a refusal keeps
// the popup open with the message (NFR4.1). Nothing runs until the page has the tab.

import type { InPlaceResult } from '../lib/driverAccount';
import { postInPlace } from './profileEditing';

/** The browser's comment check before posting (the server and database repeat it); null when fine. */
export function commentProblem(body: string, max: number): string | null {
  const length = body.trim().length;
  if (length === 0) return 'Write your comment first.';
  if (length > max) return `Your comment can be at most ${max.toLocaleString('en-US')} characters.`;
  return null;
}

export interface AppealFileLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxFileMb: number;
}

/** The browser's appeal check before posting, with the round page's limits; null when fine. */
export function appealProblem(
  message: string,
  files: { size: number }[],
  limits: AppealFileLimits,
): string | null {
  if (message.trim() === '') return 'Your appeal needs a written explanation.';
  if (files.length > limits.maxFiles) return `You can attach up to ${limits.maxFiles} files.`;
  if (files.some((f) => f.size > limits.maxFileBytes))
    return `Each file must be ${limits.maxFileMb} MB or smaller.`;
  return null;
}

/** What a row becomes after a successful action, from C4's `data` (or the action that ran). */
export type RowUpdate = { kind: 'comment' } | { kind: 'appeal' };

export function rowUpdateFor(intent: string, result: InPlaceResult): RowUpdate | null {
  if (!result.ok) return null;
  if (intent === 'add-incident-comment') return { kind: 'comment' };
  if (intent === 'submit-appeal-from-profile') return { kind: 'appeal' };
  return null;
}

// --- DOM wiring ----------------------------------------------------------------------------------

const panel = () => document.querySelector<HTMLElement>('[data-incident-management]');

function setText(root: ParentNode, selector: string, text: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (el) el.textContent = text;
}

function showError(dialog: HTMLDialogElement, message: string): void {
  const el = dialog.querySelector<HTMLElement>('[data-incident-dialog-error]');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', message === '');
}

function setStatus(result: InPlaceResult): void {
  const status = panel()?.querySelector<HTMLElement>('[data-incident-status]');
  if (!status) return;
  status.textContent = result.message;
  status.classList.toggle('text-brand-pink', !result.ok);
  status.classList.toggle('text-white/70', result.ok);
}

function applyRowUpdate(id: string, update: RowUpdate): void {
  const row = panel()?.querySelector<HTMLElement>(`[data-incident-row="${CSS.escape(id)}"]`);
  if (!row) return;
  const actions = row.querySelector<HTMLElement>('[data-incident-row-actions]');
  if (update.kind === 'comment') {
    row.querySelector('[data-incident-comment]')?.remove();
    setText(row, '[data-incident-row-status]', 'Comment sent');
    return;
  }
  row.querySelector('[data-incident-appeal]')?.remove();
  row.dataset.incidentState = 'appealed';
  row.classList.add('bg-brand-gold/10');
  setText(row, '[data-incident-row-status]', 'Appeal Submitted');
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-gold btn-sm';
  done.disabled = true;
  done.setAttribute('aria-disabled', 'true');
  done.textContent = 'Appeal Submitted';
  actions?.append(done);
}

function openComment(button: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-incident-comment-dialog]');
  const form = dialog?.querySelector<HTMLFormElement>('form[data-incident-comment-form]');
  if (!dialog || !form) return;
  form.reset();
  const data = button.dataset;
  const report = form.querySelector<HTMLInputElement>('[data-incident-comment-report]');
  if (report) report.value = data.reportId ?? '';
  setText(dialog, '[data-incident-comment-field="round"]', data.round ?? '');
  setText(dialog, '[data-incident-comment-field="session"]', data.session ?? '—');
  setText(
    dialog,
    '[data-incident-comment-field="lapturn"]',
    `Lap ${data.lap ?? '—'}, Turn ${data.turn ?? '—'}`,
  );
  // textContent only: the description and every other value here are user text.
  setText(dialog, '[data-incident-comment-field="description"]', data.description ?? '');
  dialog
    .querySelector('[data-incident-comment-description-row]')
    ?.classList.toggle('hidden', !data.description);
  showError(dialog, '');
  dialog.showModal();
  form.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

function openAppeal(button: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-incident-appeal-dialog]');
  const form = dialog?.querySelector<HTMLFormElement>('form[data-incident-appeal-form]');
  if (!dialog || !form) return;
  form.reset();
  const penalty = form.querySelector<HTMLInputElement>('[data-incident-appeal-penalty]');
  if (penalty) penalty.value = button.dataset.penaltyId ?? '';
  setText(dialog, '[data-incident-appeal-round]', button.dataset.round ?? '');
  showError(dialog, '');
  dialog.showModal();
  form.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

function localProblem(form: HTMLFormElement): string | null {
  if (form.hasAttribute('data-incident-comment-form')) {
    const body = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? '';
    return commentProblem(body, Number(form.dataset.maxLength ?? 2000));
  }
  const message = form.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.value ?? '';
  const files = [...(form.querySelector<HTMLInputElement>('[data-incident-appeal-files]')?.files ?? [])];
  return appealProblem(message, files, {
    maxFiles: Number(form.dataset.maxFiles ?? 3),
    maxFileBytes: Number(form.dataset.maxFileBytes ?? 5 * 1024 * 1024),
    maxFileMb: Number(form.dataset.maxFileMb ?? 5),
  });
}

let busy = false;

async function submit(form: HTMLFormElement): Promise<void> {
  const dialog = form.closest('dialog');
  if (!dialog || busy) return;
  const problem = localProblem(form);
  if (problem) {
    showError(dialog, problem);
    return;
  }
  const body = new FormData(form);
  const intent = String(body.get('intent') ?? '');
  const id = String(body.get('report_id') ?? body.get('penalty_id') ?? '');
  const button = form.querySelector<HTMLButtonElement>('[data-incident-dialog-submit]');
  const label = button?.textContent ?? '';
  busy = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Sending…';
  }
  try {
    // An appeal can carry three 5 MB files through the Worker, so it gets longer than the default timeout.
    const timeoutMs = intent === 'submit-appeal-from-profile' ? 60_000 : undefined;
    const result = await postInPlace(form.getAttribute('action') ?? window.location.pathname, body, { timeoutMs });
    const update = rowUpdateFor(intent, result);
    if (!update) {
      showError(dialog, result.message);
      return;
    }
    dialog.close();
    applyRowUpdate(id, update);
    setStatus(result);
  } finally {
    busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const comment = target.closest<HTMLElement>('[data-incident-comment]');
  if (comment) {
    openComment(comment);
    return;
  }
  const appeal = target.closest<HTMLElement>('[data-incident-appeal]');
  if (appeal) {
    openAppeal(appeal);
    return;
  }
  if (target.closest('[data-close-incident-dialog]')) {
    target.closest('dialog')?.close();
    return;
  }
  // Clicking the backdrop (the <dialog> itself, outside its content) closes it.
  if (
    target instanceof HTMLDialogElement &&
    (target.hasAttribute('data-incident-comment-dialog') ||
      target.hasAttribute('data-incident-appeal-dialog'))
  ) {
    target.close();
  }
}

function onSubmit(e: SubmitEvent): void {
  const form = e.target as HTMLFormElement | null;
  if (
    !form ||
    !(form.hasAttribute('data-incident-comment-form') || form.hasAttribute('data-incident-appeal-form'))
  )
    return;
  e.preventDefault();
  void submit(form);
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation.
let bound = false;
if (typeof document !== 'undefined' && !bound) {
  bound = true;
  document.addEventListener('click', onClick);
  // Capture phase, so the in-place post runs before the site-wide hard-form-submit handler.
  document.addEventListener('submit', onSubmit, true);
}
