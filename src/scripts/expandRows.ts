/**
 * Generic click-to-expand behavior for the `[data-expand-row]` /
 * `[data-detail-row]` convention used across the site — a summary
 * `<tr data-expand-row>` toggles visibility of its own immediately-
 * following `<tr data-detail-row>` sibling (Standings, Team Standings,
 * Driver Stats, and ResultsTable.astro's race-results tables all use this
 * same markup shape). Previously each of those four places carried its
 * own copy-pasted version of this script, each re-binding a fresh
 * listener on every row on every `astro:page-load`.
 *
 * That had a real bug, reported on Driver Stats: with no de-dup guard, if
 * `astro:page-load` ever fired more than once for the same still-mounted
 * content, every row picked up a SECOND click listener stacked on the
 * first — so a single click toggled the row open and then immediately
 * closed again in the same synchronous event dispatch, which looks
 * exactly like clicking did nothing at all. A full page reload reset the
 * JS context and cleared the duplicate binding, which is why it "worked
 * again after reloading."
 *
 * Fixed properly here by switching to ONE delegated listener on
 * `document`, bound exactly once ever (guarded via `document.body`'s own
 * dataset, the same de-dup convention `sortable-table.ts` and
 * `hard-form-submit.ts` already use). Delegation also means this never
 * needs to re-run after a view transition at all — `closest()` resolves
 * fresh against whatever's in the DOM at the moment of each click, so it
 * doesn't matter whether a row existed yet when this script first ran or
 * got swapped in by a later navigation.
 */
function toggleExpandRow(row: HTMLElement) {
  const detail = row.nextElementSibling as HTMLElement | null;
  if (!detail || !detail.hasAttribute('data-detail-row')) return;
  const expanded = row.getAttribute('aria-expanded') === 'true';
  row.setAttribute('aria-expanded', String(!expanded));
  detail.classList.toggle('hidden', expanded);
  row.querySelector<HTMLElement>('[data-chevron]')?.classList.toggle('rotate-90', !expanded);
}

function initExpandRows() {
  if (document.body.dataset.expandRowsInit === 'true') return;
  document.body.dataset.expandRowsInit = 'true';

  document.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row]');
    if (row) toggleExpandRow(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row]');
    if (!row) return;
    e.preventDefault();
    toggleExpandRow(row);
  });
}

// Runs immediately (document.body already exists — this script tag is at
// the end of <body>) AND on every astro:page-load as a defensive backstop;
// the guard above makes either trigger path idempotent, so there's no harm
// in both being wired up.
initExpandRows();
document.addEventListener('astro:page-load', initExpandRows);
