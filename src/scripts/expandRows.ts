/**
 * Generic click-to-expand behavior for the `[data-expand-row]` /
 * `[data-detail-row]` convention used across the site — a summary
 * `<tr data-expand-row>` toggles visibility of its own immediately-
 * following `<tr data-detail-row>` sibling (Standings, Team Standings,
 * Driver Stats, Team Stats, Hall of Fame, and ResultsTable.astro's
 * race-results tables all use this same markup shape). Previously each of
 * those places carried its own copy-pasted version of this script, each
 * re-binding a fresh listener on every row on every `astro:page-load`.
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
 * Fixed by switching to ONE delegated listener on `document`, meant to be
 * bound exactly once ever. Delegation also means this never needs to
 * re-run after a view transition at all — `closest()` resolves fresh
 * against whatever's in the DOM at the moment of each click, so it
 * doesn't matter whether a row existed yet when this script first ran or
 * got swapped in by a later navigation.
 *
 * v2: the de-dup guard itself was wrong, which is why the bug came back —
 * reported this time on Driver Stats, Team Stats, AND Hall of Fame, working
 * again only after a full reload of whichever tab had just been visited.
 * It was living on `document.body.dataset`, the same convention
 * `sortable-table.ts`/`hard-form-submit.ts` use — but those bind their
 * listeners directly to elements they re-query on every `astro:page-load`
 * (a fresh table/form each navigation, so a fresh, correctly-unset dataset
 * flag on it is exactly right). This script is different: the LISTENER
 * lives on `document`, which Astro's client router (`<ViewTransitions />`)
 * never replaces across a soft navigation — only `document.body` itself
 * gets swapped out for the new page's body. So the guard kept resetting to
 * unset on every navigation while the listener it was supposed to be
 * guarding kept accumulating on the one `document` that never went away:
 * two clicks' worth of navigations meant two listeners meant a click
 * toggled a row open then immediately closed again, same symptom as the
 * original bug, just triggered by soft navigation between tabs instead of
 * a stray extra `astro:page-load` firing. A full reload created a brand
 * new `document` (and JS context) with exactly one listener again, which
 * is why reloading "fixed" it — until the next tab switch.
 *
 * Fixed properly this time by guarding on `window` instead, which (like
 * `document`) is never replaced by a soft navigation, so the flag set on
 * first run is still there on every later one.
 */
declare global {
  interface Window {
    __expandRowsInit?: boolean;
  }
}

function toggleExpandRow(row: HTMLElement) {
  const detail = row.nextElementSibling as HTMLElement | null;
  if (!detail || !detail.hasAttribute('data-detail-row')) return;
  const expanded = row.getAttribute('aria-expanded') === 'true';
  row.setAttribute('aria-expanded', String(!expanded));
  detail.classList.toggle('hidden', expanded);
  row.querySelector<HTMLElement>('[data-chevron]')?.classList.toggle('rotate-90', !expanded);
}

function initExpandRows() {
  if (window.__expandRowsInit) return;
  window.__expandRowsInit = true;

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
