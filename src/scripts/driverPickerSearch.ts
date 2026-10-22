/**
 * Search box for a list of driver checkboxes/radios (Report Incident "Cars Involved", steward "Driver at Fault"):
 *   <div data-driver-picker><input type="search" data-driver-search />
 *     <label data-driver-option data-search="#14 jane doe">…</label> <p data-driver-search-empty class="hidden"></p></div>
 * Typing hides non-matching options; checked options and ones without data-search always stay. Optional
 * data-driver-sort="number|name" buttons reorder by data-sort-number / data-sort-name. Delegated on `document`
 * once; after changing the list in code, clear the box and dispatch `input` on it.
 */

let initialized = false;

function filterPicker(picker: HTMLElement) {
  const input = picker.querySelector<HTMLInputElement>('[data-driver-search]');
  const term = (input?.value ?? '').trim().toLowerCase();
  let visible = 0;
  picker.querySelectorAll<HTMLElement>('[data-driver-option]').forEach((option) => {
    const checked = option.querySelector<HTMLInputElement>('input')?.checked ?? false;
    const show = !term || checked || (option.dataset.search ?? '').includes(term);
    option.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  picker.querySelector<HTMLElement>('[data-driver-search-empty]')?.classList.toggle('hidden', visible > 0);
}

/** Reorders the picker's options in place (they share one parent), keeping the empty-state line last. */
function sortPicker(picker: HTMLElement, by: string) {
  const options = [...picker.querySelectorAll<HTMLElement>('[data-driver-option][data-sort-name]')];
  if (!options.length) return;
  const num = (o: HTMLElement) => Number(o.dataset.sortNumber ?? Infinity);
  const name = (o: HTMLElement) => o.dataset.sortName ?? '';
  options.sort((a, b) =>
    by === 'name'
      ? name(a).localeCompare(name(b)) || num(a) - num(b)
      : num(a) - num(b) || name(a).localeCompare(name(b)),
  );
  const parent = options[0].parentElement!;
  const empty = parent.querySelector(':scope > [data-driver-search-empty]');
  for (const o of options) parent.insertBefore(o, empty);
  picker
    .querySelectorAll<HTMLElement>('[data-driver-sort]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.driverSort === by)));
}

function init() {
  if (initialized) return;
  initialized = true;

  document.addEventListener('input', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-driver-search]');
    const picker = input?.closest<HTMLElement>('[data-driver-picker]');
    if (picker) filterPicker(picker);
  });

  document.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-driver-sort]');
    const picker = button?.closest<HTMLElement>('[data-driver-picker]');
    if (button && picker) sortPicker(picker, button.dataset.driverSort ?? 'number');
  });

  // Enter in the search box would otherwise submit the surrounding form.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).closest('[data-driver-search]')) e.preventDefault();
  });

  // form.reset() clears the search box without an input event; the reset
  // event fires before the fields are cleared, so re-filter on the next tick.
  document.addEventListener('reset', (e) => {
    const form = e.target as HTMLElement;
    setTimeout(() => form.querySelectorAll<HTMLElement>('[data-driver-picker]').forEach(filterPicker), 0);
  });
}

init();

export {};
