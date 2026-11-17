// Edit Results on the Race Results page (US9.1), full admins only: Edit Results swaps each incident count for
// an input, Save Results checks them and posts only the changed rows, Cancel or Escape puts everything back.
// Imported by the results shell because the table renders in a fetched fragment where scripts don't run. The
// server and the database check every value again.

export interface IncidentEntry {
  value: string;
  current: string;
  driverName: string;
}

/** A whole number from 0 to 999, typed as digits only (no sign, decimal point or exponent). */
export function isValidIncidentValue(raw: string): boolean {
  const value = raw.trim();
  return /^\d{1,3}$/.test(value) && Number(value) <= 999;
}

/** The first driver whose value is not a valid count, or null when every value is valid. */
export function findInvalidIncidents(entries: IncidentEntry[]): string | null {
  for (const entry of entries) {
    if (!isValidIncidentValue(entry.value)) return entry.driverName;
  }
  return null;
}

/** The entries whose value differs from the count on the page ("05" and "5" are the same count). */
export function changedIncidentEntries<T extends IncidentEntry>(entries: T[]): T[] {
  return entries.filter((entry) => {
    const value = entry.value.trim();
    const current = entry.current.trim();
    if (current === '') return value !== '';
    return !isValidIncidentValue(value) || Number(value) !== Number(current);
  });
}

function inputsFor(form: HTMLFormElement): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[data-incidents-input][form="${form.id}"]`)];
}

function setEditing(form: HTMLFormElement, editing: boolean) {
  form.dataset.editing = String(editing);
  const toggle = form.querySelector<HTMLButtonElement>('[data-edit-incidents-toggle]');
  const cancel = form.querySelector<HTMLButtonElement>('[data-edit-incidents-cancel]');
  if (toggle) {
    toggle.textContent = editing ? 'Save Results' : 'Edit Results';
    toggle.setAttribute('aria-pressed', String(editing));
    toggle.classList.toggle('btn-primary', editing);
    toggle.classList.toggle('btn-neutral', !editing);
  }
  if (cancel) cancel.hidden = !editing;
  for (const input of inputsFor(form)) {
    input.hidden = !editing;
    input.disabled = false;
    const display = input.parentElement?.querySelector<HTMLElement>('[data-incidents-display]');
    if (display) display.hidden = editing;
  }
  if (!editing) showError(form, null);
}

function showError(form: HTMLFormElement, message: string | null) {
  const line = form.querySelector<HTMLElement>('[data-edit-incidents-error]');
  if (!line) return;
  line.textContent = message ?? '';
  line.hidden = message === null;
}

function entryOf(input: HTMLInputElement): IncidentEntry & { input: HTMLInputElement } {
  return {
    input,
    value: input.value,
    current: input.dataset.current ?? '',
    driverName: input.dataset.driverName ?? 'a driver',
  };
}

function cancel(form: HTMLFormElement) {
  for (const input of inputsFor(form)) input.value = input.dataset.current ?? '';
  setEditing(form, false);
  form.querySelector<HTMLButtonElement>('[data-edit-incidents-toggle]')?.focus();
}

function save(form: HTMLFormElement) {
  const entries = inputsFor(form).map(entryOf);
  const changed = changedIncidentEntries(entries);
  if (changed.length === 0) {
    setEditing(form, false);
    return;
  }
  const invalid = findInvalidIncidents(changed);
  if (invalid !== null) {
    showError(form, `Enter a whole number from 0 to 999 for ${invalid}.`);
    changed.find((entry) => entry.driverName === invalid)?.input.focus();
    return;
  }
  // Disabled fields aren't submitted, so only the changed rows reach the server.
  const changedInputs = new Set(changed.map((entry) => entry.input));
  for (const entry of entries) entry.input.disabled = !changedInputs.has(entry.input);
  const toggle = form.querySelector<HTMLButtonElement>('[data-edit-incidents-toggle]');
  if (toggle) toggle.disabled = true;
  form.submit();
}

function initEditIncidents() {
  if (document.body.dataset.editIncidentsInit === 'true') return;
  document.body.dataset.editIncidentsInit = 'true';

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const toggle = target.closest<HTMLButtonElement>('[data-edit-incidents-toggle]');
    const form = (toggle ?? target.closest('[data-edit-incidents-cancel]'))?.closest<HTMLFormElement>(
      'form[data-edit-incidents-form]',
    );
    if (!form) return;
    if (!toggle) {
      cancel(form);
      return;
    }
    if (form.dataset.editing === 'true') save(form);
    else {
      setEditing(form, true);
      inputsFor(form)[0]?.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    const form = document.querySelector<HTMLFormElement>(
      'form[data-edit-incidents-form][data-editing="true"]',
    );
    if (!form) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel(form);
    } else if (e.key === 'Enter' && (e.target as HTMLElement).closest('input[data-incidents-input]')) {
      e.preventDefault();
      save(form);
    }
  });
}

// A refused save comes back with an error banner: reopen edit mode so the admin can correct it.
function reopenAfterFailedSave() {
  const flash = document.querySelector<HTMLElement>('[data-incidents-flash][data-tone="error"]');
  const form = document.querySelector<HTMLFormElement>('form[data-edit-incidents-form]');
  if (flash && form && form.dataset.editing !== 'true' && !form.dataset.reopened) {
    form.dataset.reopened = 'true';
    setEditing(form, true);
  }
}

if (typeof document !== 'undefined') {
  initEditIncidents();
  document.addEventListener('astro:page-load', () => {
    initEditIncidents();
    // fragmentLoader fires astro:page-load again once the table's fragment is in.
    reopenAfterFailedSave();
  });
}
