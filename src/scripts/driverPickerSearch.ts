/**
 * Search box for a list of driver checkboxes/radios — the Report Incident
 * dialog's "Cars Involved" grid and the steward review dialog's "Driver at
 * Fault" list. Markup convention:
 *
 *   <div data-driver-picker>
 *     <input type="search" data-driver-search />
 *     <label data-driver-option data-search="#14 jane doe">…</label>   (one per driver)
 *     <p data-driver-search-empty class="hidden">No matches.</p>
 *   </div>
 *
 * Typing hides options whose data-search doesn't contain the term (same
 * plain `includes` match as the site's other [data-search] filters). An
 * option that's already checked always stays visible, so filtering never
 * hides a choice you've made. Options without data-search (e.g. a pinned
 * "Racing Incident") are never filtered.
 *
 * One delegated listener set on `document`, bound once per JS context with
 * a module-scoped guard — see expandRows.ts's header for why not a flag on
 * document.body. Code that changes the list programmatically (opening a
 * dialog pre-filled) can clear the search box and dispatch an `input` event
 * on it to re-filter.
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

function init() {
  if (initialized) return;
  initialized = true;

  document.addEventListener('input', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('[data-driver-search]');
    const picker = input?.closest<HTMLElement>('[data-driver-picker]');
    if (picker) filterPicker(picker);
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
