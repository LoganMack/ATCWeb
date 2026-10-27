// The Link Driver page's search, confirm dialog and New Driver Sign-Up popup (U2 driver-linking, BR3.4, BR3.5;
// broadcaster-staff-roles C6); imported by src/pages/link-driver.astro only. Search filters the rendered rows in
// the browser, with no request per keystroke (NFR3.3). The server re-checks everything the dialogs submit, and
// the car-number hint is only a hint (BR5.2).
import { carNumberStatus } from '../lib/carNumberStatus';

export interface FilterableDriver {
  /** The driver's name as shown. */
  name: string;
  /** The car number as text, '' when the driver has none. */
  number: string;
}

/**
 * BR3.4: the name contains the query (case-insensitive, trimmed); a query of digits also matches car numbers
 * starting with those digits. An empty query matches every driver.
 */
export function matchesDriver(driver: FilterableDriver, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (driver.name.toLowerCase().includes(q)) return true;
  return /^\d+$/.test(q) && driver.number !== '' && driver.number.startsWith(q);
}

export function filterDrivers<T extends FilterableDriver>(drivers: T[], query: string): T[] {
  return drivers.filter((driver) => matchesDriver(driver, query));
}

/** Whether a list row stays visible: the Broadcaster row always does, whatever the search (C6). */
export function rowShown(row: FilterableDriver & { alwaysShown: boolean }, query: string): boolean {
  return row.alwaysShown || matchesDriver(row, query);
}

/** What the confirm dialog says and posts for the row that opened it. */
export function confirmDialogCopy(trigger: { broadcaster: boolean; name: string; number: string }): {
  intent: 'link-driver' | 'claim-broadcaster';
  title: string;
  confirmLabel: string;
} {
  if (trigger.broadcaster) {
    return {
      intent: 'claim-broadcaster',
      title: 'Become the Broadcaster?',
      confirmLabel: 'Become Broadcaster',
    };
  }
  const label = trigger.number ? `${trigger.name} (#${trigger.number})` : trigger.name;
  return { intent: 'link-driver', title: `Link to ${label}?`, confirmLabel: 'Link Driver' };
}

/** The hint under Car Number: words plus the status colour, or nothing until the text is a number 0-999. */
export function numberStatusView(
  raw: string,
  taken: readonly number[],
): { text: string; className: string } | null {
  const status = carNumberStatus(raw, taken);
  if (!status) return null;
  return { text: status.message, className: status.taken ? 'text-brand-pink' : 'text-brand-primary' };
}

/** The taken numbers from the page's JSON island; anything unreadable means no hint, never an error. */
export function parseTakenNumbers(json: string | null | undefined): number[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/** The parts of a <dialog> the sign-up popup uses, so tests can pass a stand-in. */
export interface DialogLike {
  open: boolean;
  dataset: DOMStringMap;
  showModal(): void;
  close(): void;
  querySelector<E extends Element = Element>(selectors: string): E | null;
}

export function openSignupDialog(dialog: DialogLike): void {
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

export function closeSignupDialog(dialog: DialogLike): void {
  if (dialog.open) dialog.close();
}

/** A page rendered with a sign-up error opens the popup again, keeping the values and the message (W5). */
export function openSignupOnLoad(dialog: DialogLike | null): boolean {
  if (!dialog || dialog.dataset.openOnLoad !== 'true' || dialog.open) return false;
  openSignupDialog(dialog);
  return true;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select, textarea';

function applySearch(root: HTMLElement, query: string): void {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-link-driver-row]')];
  let shown = 0;
  for (const row of rows) {
    const alwaysShown = row.hasAttribute('data-always-shown');
    const match = rowShown(
      { alwaysShown, name: row.dataset.name ?? '', number: row.dataset.number ?? '' },
      query,
    );
    // A class, not the hidden attribute: the row's `flex` utility would override [hidden].
    row.classList.toggle('hidden', !match);
    row.classList.toggle('flex', match);
    if (match && !alwaysShown) shown += 1;
  }
  const driverRows = rows.filter((row) => !row.hasAttribute('data-always-shown'));
  const noMatch = root.querySelector<HTMLElement>('[data-link-driver-no-match]');
  const queryEl = root.querySelector<HTMLElement>('[data-link-driver-query]');
  if (queryEl) queryEl.textContent = query.trim();
  if (noMatch) noMatch.hidden = driverRows.length === 0 || shown > 0 || query.trim() === '';
}

function openDialog(dialog: HTMLDialogElement, trigger: HTMLElement): void {
  const copy = confirmDialogCopy({
    broadcaster: trigger.hasAttribute('data-broadcaster'),
    name: trigger.dataset.driverName ?? '',
    number: trigger.dataset.driverNumber ?? '',
  });
  const intentInput = dialog.querySelector<HTMLInputElement>('input[name="intent"]');
  const idInput = dialog.querySelector<HTMLInputElement>('input[name="driver_id"]');
  const nameInput = dialog.querySelector<HTMLInputElement>('input[name="driver_name"]');
  const title = dialog.querySelector<HTMLElement>('[data-link-driver-dialog-title]');
  const confirm = dialog.querySelector<HTMLElement>('[data-link-driver-confirm]');
  if (!intentInput || !idInput || !nameInput || !title || !confirm) return;
  intentInput.value = copy.intent;
  idInput.value = trigger.dataset.driverId ?? '';
  nameInput.value = trigger.dataset.driverName ?? '';
  title.textContent = copy.title;
  confirm.textContent = copy.confirmLabel;
  dialog.showModal();
  // Cancel first, so Enter never links by accident.
  dialog.querySelector<HTMLElement>('.btn[data-link-driver-cancel]')?.focus();
}

/** Keeps Tab inside the open dialog. Escape is the dialog's own cancel. */
function trapFocus(dialog: HTMLDialogElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !dialog.open) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function updateNumberStatus(input: HTMLInputElement): void {
  const dialog = input.closest<HTMLDialogElement>('dialog[data-signup-dialog]');
  const statusEl = dialog?.querySelector<HTMLElement>('[data-signup-number-status]');
  if (!dialog || !statusEl) return;
  const taken = parseTakenNumbers(dialog.querySelector('script[data-taken-numbers]')?.textContent);
  const view = numberStatusView(input.value, taken);
  statusEl.textContent = view?.text ?? '';
  statusEl.className = `min-h-4 text-xs ${view?.className ?? ''}`.trim();
}

function handleClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const root = target.closest<HTMLElement>('[data-link-driver]');
  if (!root) return;
  const signup = root.querySelector<HTMLDialogElement>('dialog[data-signup-dialog]');
  if (signup && target.closest('[data-signup-open]')) return openSignupDialog(signup);
  if (signup && (target.closest('[data-signup-close]') || target === signup))
    return closeSignupDialog(signup);
  const trigger = target.closest<HTMLElement>('[data-link-driver-open]');
  const dialog = root.querySelector<HTMLDialogElement>('dialog[data-link-driver-dialog]');
  if (trigger && dialog) return openDialog(dialog, trigger);
  // A click on the backdrop lands on the <dialog> itself.
  if (target.closest('[data-link-driver-cancel]') || target === dialog) dialog?.close();
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation (expandRows.ts).
let initialized = false;
function initLinkDriver(): void {
  openSignupOnLoad(document.querySelector<HTMLDialogElement>('dialog[data-signup-dialog]'));
  if (initialized) return;
  initialized = true;
  document.addEventListener('input', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.hasAttribute('data-signup-number')) return updateNumberStatus(input);
    if (!input.hasAttribute('data-link-driver-search')) return;
    const root = input.closest<HTMLElement>('[data-link-driver]');
    if (root) applySearch(root, input.value);
  });
  document.addEventListener('click', handleClick);
  document.addEventListener('keydown', (e) => {
    const dialog = document.querySelector<HTMLDialogElement>(
      'dialog[data-link-driver-dialog][open], dialog[data-signup-dialog][open]',
    );
    if (dialog) trapFocus(dialog, e);
  });
}

if (typeof document !== 'undefined') {
  initLinkDriver();
  document.addEventListener('astro:page-load', initLinkDriver);
}
