// The own profile's Interviews tab (U6; BR12.3, BR12.4, BR12.8; contract C4), imported by
// src/pages/drivers/[id].astro only. Download posts in place and sends the browser to the signed link; Delete
// asks in a confirm popup, posts in place and removes the row on success. A refusal keeps the popup open
// with the message, and the row stays (NFR4.1). Only the intent and the id are posted, never the held fields.

import type { InPlaceResult } from '../lib/driverAccount';
import { inPlaceBody, postInPlace } from './profileEditing';

/** The confirm popup's text: the round, and the closed-window line when a new recording is no longer possible. */
export function deleteConfirmLines(roundLabel: string, windowOpen: boolean | null): string[] {
  const lines = [`Delete your interview for ${roundLabel}? This can't be undone.`];
  if (windowOpen === false) lines.push("You can't record a new one for this round any more.");
  return lines;
}

/** The signed link of a successful download answer, or null; only a web link is followed. */
export function downloadUrlOf(result: InPlaceResult): string | null {
  if (!result.ok) return null;
  const url = result.data?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// --- DOM wiring ----------------------------------------------------------------------------------

const panel = () => document.querySelector<HTMLElement>('[data-interviews-panel]');
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-interview-delete-dialog]');

function setStatus(result: InPlaceResult): void {
  const status = panel()?.querySelector<HTMLElement>('[data-interviews-status]');
  if (!status) return;
  status.textContent = result.message;
  status.classList.toggle('text-brand-pink', !result.ok);
  status.classList.toggle('text-white/70', result.ok);
}

function showDialogError(message: string): void {
  const el = dialog()?.querySelector<HTMLElement>('[data-interview-delete-error]');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', message === '');
}

function removeRow(id: string): void {
  const root = panel();
  root?.querySelector(`[data-interview-row="${CSS.escape(id)}"]`)?.remove();
  if (root && !root.querySelector('[data-interview-row]')) {
    root.querySelector('[data-interviews-list]')?.classList.add('hidden');
    root.querySelector('[data-interviews-empty]')?.classList.remove('hidden');
  }
}

let busy = false;

/** Runs one in-place post with the button disabled; nothing else starts until it answers. */
async function post(button: HTMLButtonElement, intent: string, id: string): Promise<InPlaceResult | null> {
  if (busy) return null;
  busy = true;
  button.disabled = true;
  try {
    return await postInPlace(window.location.pathname, inPlaceBody(intent, [['interview_id', id]]));
  } finally {
    busy = false;
    button.disabled = false;
  }
}

async function download(button: HTMLButtonElement): Promise<void> {
  const result = await post(button, 'download-interview', button.dataset.interviewId ?? '');
  if (!result) return;
  const url = downloadUrlOf(result);
  if (url) window.location.assign(url);
  else setStatus(result.ok ? { ok: false, message: "Couldn't prepare the download. Try again." } : result);
}

function openDelete(button: HTMLElement): void {
  const popup = dialog();
  if (!popup) return;
  const flag = button.dataset.windowOpen;
  const windowOpen = flag === 'true' ? true : flag === 'false' ? false : null;
  const [question, closed] = deleteConfirmLines(button.dataset.round ?? '', windowOpen);
  const text = popup.querySelector<HTMLElement>('[data-interview-delete-text]');
  if (text) text.textContent = question;
  const closedLine = popup.querySelector<HTMLElement>('[data-interview-delete-closed]');
  if (closedLine) {
    closedLine.textContent = closed ?? '';
    closedLine.classList.toggle('hidden', !closed);
  }
  popup.dataset.interviewId = button.dataset.interviewId ?? '';
  showDialogError('');
  popup.showModal();
}

async function confirmDelete(button: HTMLButtonElement): Promise<void> {
  const popup = dialog();
  const id = popup?.dataset.interviewId ?? '';
  if (!popup || !id) return;
  const result = await post(button, 'delete-interview', id);
  if (!result) return;
  if (!result.ok) {
    showDialogError(result.message);
    return;
  }
  popup.close();
  removeRow(id);
  setStatus(result);
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const downloadButton = target.closest<HTMLButtonElement>('button[data-interview-download]');
  if (downloadButton) {
    void download(downloadButton);
    return;
  }
  const deleteButton = target.closest<HTMLButtonElement>('button[data-interview-delete]');
  if (deleteButton) {
    openDelete(deleteButton);
    return;
  }
  const confirm = target.closest<HTMLButtonElement>('button[data-interview-delete-confirm]');
  if (confirm) {
    void confirmDelete(confirm);
    return;
  }
  if (target.closest('[data-interview-delete-cancel]')) {
    dialog()?.close();
    return;
  }
  // Clicking the backdrop (the <dialog> itself, outside its content) closes it.
  if (target instanceof HTMLDialogElement && target.hasAttribute('data-interview-delete-dialog')) {
    target.close();
  }
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation.
let bound = false;
if (typeof document !== 'undefined' && !bound) {
  bound = true;
  document.addEventListener('click', onClick);
}
