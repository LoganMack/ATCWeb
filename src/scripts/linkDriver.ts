// The linking page's search, confirm dialog and request form (U2 driver-linking, BR3.4, BR3.5); imported by
// src/pages/link-driver.astro only. Search filters the rendered rows in the browser, with no request per
// keystroke (NFR3.3). The server re-checks everything the dialog submits.

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

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select, textarea';

function applySearch(root: HTMLElement, query: string): void {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-link-driver-row]')];
  let shown = 0;
  for (const row of rows) {
    const match = matchesDriver({ name: row.dataset.name ?? '', number: row.dataset.number ?? '' }, query);
    // A class, not the hidden attribute: the row's `flex` utility would override [hidden].
    row.classList.toggle('hidden', !match);
    row.classList.toggle('flex', match);
    if (match) shown += 1;
  }
  const noMatch = root.querySelector<HTMLElement>('[data-link-driver-no-match]');
  const queryEl = root.querySelector<HTMLElement>('[data-link-driver-query]');
  if (queryEl) queryEl.textContent = query.trim();
  if (noMatch) noMatch.hidden = rows.length === 0 || shown > 0;
}

function openDialog(dialog: HTMLDialogElement, trigger: HTMLElement): void {
  const id = trigger.dataset.driverId ?? '';
  const name = trigger.dataset.driverName ?? '';
  const number = trigger.dataset.driverNumber ?? '';
  const idInput = dialog.querySelector<HTMLInputElement>('input[name="driver_id"]');
  const nameInput = dialog.querySelector<HTMLInputElement>('input[name="driver_name"]');
  const label = dialog.querySelector<HTMLElement>('[data-link-driver-dialog-name]');
  if (!idInput || !nameInput || !label) return;
  idInput.value = id;
  nameInput.value = name;
  label.textContent = number ? `${name} (#${number})` : name;
  dialog.showModal();
  // Cancel first, so Enter never links by accident.
  dialog.querySelector<HTMLElement>('[data-link-driver-cancel]')?.focus();
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

function toggleRequestForm(root: HTMLElement, open: boolean): void {
  const form = root.querySelector<HTMLElement>('[data-link-driver-request-form]');
  const toggle = root.querySelector<HTMLElement>('[data-link-driver-request-toggle]');
  if (!form) return;
  form.classList.toggle('hidden', !open);
  form.classList.toggle('flex', open);
  toggle?.setAttribute('aria-expanded', String(open));
  if (open) form.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation (expandRows.ts).
let initialized = false;
function initLinkDriver(): void {
  if (initialized) return;
  initialized = true;
  document.addEventListener('input', (e) => {
    const input = e.target as HTMLElement;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-link-driver-search')) return;
    const root = input.closest<HTMLElement>('[data-link-driver]');
    if (root) applySearch(root, input.value);
  });
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const root = target.closest<HTMLElement>('[data-link-driver]');
    if (!root) return;
    const trigger = target.closest<HTMLElement>('[data-link-driver-open]');
    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-link-driver-dialog]');
    if (trigger && dialog) {
      openDialog(dialog, trigger);
      return;
    }
    if (target.closest('[data-link-driver-cancel]')) {
      target.closest('dialog')?.close();
      return;
    }
    // A click on the backdrop lands on the <dialog> itself.
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-link-driver-dialog')) {
      target.close();
      return;
    }
    if (target.closest('[data-link-driver-request-toggle]')) toggleRequestForm(root, true);
    else if (target.closest('[data-link-driver-request-cancel]')) toggleRequestForm(root, false);
  });
  document.addEventListener('keydown', (e) => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-link-driver-dialog][open]');
    if (dialog) trapFocus(dialog, e);
  });
}

if (typeof document !== 'undefined') {
  initLinkDriver();
  document.addEventListener('astro:page-load', initLinkDriver);
}
