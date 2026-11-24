// Plain substring search across each layout's circuit name + display name (data-search, lowercased
// server-side), the same show/hide-via-inline-style approach the roster/teams filters use. Bound once per
// input, because an expanded layout row re-dispatches astro:page-load (circuitLayoutDetail.ts).
export function initCircuitSearch() {
  // Attribute selectors return the same single element getElementById did; the test fake DOM supports them.
  const input = document.querySelector('[id="circuit-search"]') as HTMLInputElement | null;
  const list = document.querySelector('[id="circuit-list"]') as HTMLElement | null;
  const empty = document.querySelector('[id="circuit-search-empty"]') as HTMLElement | null;
  if (!input || !list) return;
  if (input.dataset.searchBound === 'true') return;
  input.dataset.searchBound = 'true';

  function applySearch() {
    const q = input!.value.trim().toLowerCase();
    const rows = list!.querySelectorAll<HTMLElement>('[data-search]');
    let visibleCount = 0;
    rows.forEach((row) => {
      const matches = !q || (row.dataset.search ?? '').includes(q);
      row.hidden = !matches;
      // Hide a filtered-out row's detail row too, in case it was left open.
      const detail = row.nextElementSibling as HTMLElement | null;
      if (detail && detail.hasAttribute('data-detail-row')) {
        detail.hidden = !matches;
      }
      if (matches) visibleCount += 1;
    });
    if (empty) empty.classList.toggle('hidden', visibleCount > 0);
  }

  input.addEventListener('input', applySearch);
  applySearch();
}

document.addEventListener('astro:page-load', initCircuitSearch);
