/**
 * The admin circuit editor (admin/circuits/[id].astro; circuit-editor BR1.5, BR1.14): the layout and track
 * guide dialogs (open, Cancel and Escape reset, focus return, reopen after a refused save), the Logo
 * Background custom row with its picker and text kept in step and a live preview, and the delete confirm.
 * It writes no HTML: only `.value`, fixed attribute names and the validated `--logo-bg` property.
 */
import { normaliseLogoColour } from '../lib/circuitCategory';

const openers = new WeakMap<HTMLDialogElement, HTMLElement>();
const submitted = new WeakSet<HTMLDialogElement>();
let documentBound = false;

function dialogById(id: string): HTMLDialogElement | null {
  // An attribute selector rather than #id, so ids need no escaping beyond quotes.
  return document.querySelector<HTMLDialogElement>(`dialog[id="${CSS.escape(id)}"]`);
}

function bindDialog(dialog: HTMLDialogElement) {
  if (dialog.hasAttribute('data-dialog-bound')) return;
  dialog.setAttribute('data-dialog-bound', '');
  const form = dialog.querySelector<HTMLFormElement>('form');
  form?.addEventListener('submit', () => submitted.add(dialog));
  // `close` fires for Cancel, the ✕ and Escape alike: whatever was typed is thrown away.
  dialog.addEventListener('close', () => {
    if (!submitted.has(dialog)) form?.reset();
    const opener =
      openers.get(dialog) ?? document.querySelector<HTMLElement>(`[data-open-dialog="${CSS.escape(dialog.id)}"]`);
    opener?.focus();
  });
}

function showDialog(dialog: HTMLDialogElement) {
  bindDialog(dialog);
  if (!dialog.open) dialog.showModal();
  const target =
    dialog.querySelector<HTMLElement>('[aria-invalid="true"]') ??
    dialog.querySelector<HTMLElement>('[data-first-field]');
  target?.focus();
}

export function openDialog(button: HTMLElement): HTMLDialogElement | null {
  const dialog = dialogById(button.getAttribute('data-open-dialog') ?? '');
  if (!dialog) return null;
  openers.set(dialog, button);
  // The one track guide dialog serves every layout: the opener says which.
  const layoutId = button.getAttribute('data-layout-id');
  if (layoutId !== null) {
    const hidden = dialog.querySelector<HTMLInputElement>('input[name="layout_id"]');
    if (hidden) hidden.value = layoutId;
  }
  showDialog(dialog);
  return dialog;
}

export function closeDialog(dialog: HTMLDialogElement) {
  dialog.close();
}

function onDocumentClick(event: Event) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest) return;
  const opener = target.closest<HTMLElement>('[data-open-dialog]');
  if (opener) {
    openDialog(opener);
    return;
  }
  const closer = target.closest<HTMLElement>('[data-close-dialog]');
  const dialog = closer?.closest<HTMLDialogElement>('dialog');
  if (dialog) closeDialog(dialog);
}

const customRowOf = (fieldset: HTMLElement) => fieldset.querySelector<HTMLElement>('[data-logo-bg-custom-row]');
const pickerOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[type="color"]');
const textOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[name="logo_background_hex"]');

/** Shows the custom row only while Custom is chosen; returns the chosen radio's value ('' for None). */
export function showCustomRow(fieldset: HTMLElement): string {
  const radios = [...fieldset.querySelectorAll<HTMLInputElement>('input[name="logo_background"]')];
  const mode = radios.find((r) => r.checked)?.value ?? '';
  const row = customRowOf(fieldset);
  if (row) row.hidden = mode !== 'custom';
  return mode;
}

/** Copies the picker into the text field; returns the colour. */
export function syncFromPicker(row: HTMLElement): string | null {
  const picker = pickerOf(row);
  const text = textOf(row);
  if (!picker || !text) return null;
  text.value = picker.value;
  return normaliseLogoColour(picker.value);
}

/** Moves the picker to a valid typed colour and returns it; invalid text leaves the picker alone (null). */
export function syncFromText(row: HTMLElement): string | null {
  const picker = pickerOf(row);
  const text = textOf(row);
  if (!text) return null;
  const colour = normaliseLogoColour(text.value);
  if (colour && picker) picker.value = colour;
  return colour;
}

/** Draws a custom plate on the preview; a null colour leaves the preview as it was. */
export function applyPreview(img: HTMLElement | null, value: string | null) {
  if (!img || value === null) return;
  img.setAttribute('data-logo-bg', 'custom');
  img.style.setProperty('--logo-bg', value);
}

function bindLogoBackground(fieldset: HTMLElement) {
  const preview = () => document.querySelector<HTMLElement>('[data-logo-preview]');
  fieldset.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.getAttribute('name') !== 'logo_background') return;
    const mode = showCustomRow(fieldset);
    const img = preview();
    if (mode === 'custom') {
      const row = customRowOf(fieldset);
      applyPreview(img, row ? normaliseLogoColour(textOf(row)?.value ?? '') : null);
    } else if (img) {
      if (mode) img.setAttribute('data-logo-bg', mode);
      else img.removeAttribute('data-logo-bg');
    }
  });
  fieldset.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    const row = target?.closest<HTMLElement>('[data-logo-bg-custom-row]');
    if (!target || !row) return;
    const colour = target.getAttribute('type') === 'color' ? syncFromPicker(row) : syncFromText(row);
    applyPreview(preview(), colour);
  });
}

export function initCircuitEditor() {
  const form = document.querySelector<HTMLFormElement>('[data-circuit-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', '');

  // The document outlives page swaps, so its delegated listener is added once.
  if (!documentBound) {
    document.addEventListener('click', onDocumentClick);
    documentBound = true;
  }

  document.querySelectorAll<HTMLButtonElement>('[data-confirm]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (!confirm(btn.dataset.confirm || 'Are you sure?')) e.preventDefault();
    });
  });

  const fieldset = form.querySelector<HTMLElement>('[data-logo-bg-fieldset]');
  if (fieldset) bindLogoBackground(fieldset);

  // A refused layout save renders its dialog marked to reopen with the message and the typed values.
  document.querySelectorAll<HTMLDialogElement>('dialog[data-open-on-load]').forEach(showDialog);
}

/** For tests: the document listener is module state. */
export function resetCircuitEditorForTests() {
  documentBound = false;
}

if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initCircuitEditor);
