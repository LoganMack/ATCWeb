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
 * `document`, bound exactly once ever. Delegation also means this never
 * needs to re-run after a view transition at all — `closest()` resolves
 * fresh against whatever's in the DOM at the moment of each click, so it
 * doesn't matter whether a row existed yet when this script first ran or
 * got swapped in by a later navigation.
 *
 * The de-dup guard below is a plain module-scoped variable, NOT
 * `document.body`'s dataset (an earlier version used that, matching the
 * convention `sortable-table.ts` and `hard-form-submit.ts` use). That was
 * itself a live bug: Astro's client router replaces `document.body` with a
 * freshly-parsed element on every soft navigation, so a flag stored on it
 * only ever survives until the next navigation — while the `click`/`keydown`
 * listeners below are bound to `document` itself, which is never replaced.
 * Every soft navigation therefore re-passed the (reset) guard and stacked
 * another pair of listeners onto `document`, which never get removed. Two
 * or three navigations deep, a single click fires the handler 2-3 times in
 * the same synchronous dispatch — an even count nets back to the original
 * state (looks like clicking does nothing at all, reproduced live on Team
 * Stats after Home → Teams → History → Team Stats); an odd count still
 * toggles, just via a different listener than you'd expect. Per-element
 * dataset guards are still correct for sortable-table.ts/hard-form-submit.ts
 * (they must re-run their setup against each newly-appeared table/form), but
 * this listener is deliberately bound exactly once for the page's entire
 * lifetime, so it needs a guard that isn't tied to an element Astro can swap
 * out from under it — a module-scoped variable, scoped to this script's own
 * single execution (bundled module scripts execute at most once per page
 * load, soft navigations included), fits that exactly.
 */
let expandRowsInitialized = false;

function toggleExpandRow(row: HTMLElement) {
  const detail = row.nextElementSibling as HTMLElement | null;
  if (!detail || !detail.hasAttribute('data-detail-row')) return;
  const expanded = row.getAttribute('aria-expanded') === 'true';
  row.setAttribute('aria-expanded', String(!expanded));
  detail.classList.toggle('hidden', expanded);
  row.querySelector<HTMLElement>('[data-chevron]')?.classList.toggle('rotate-90', !expanded);
}

function initExpandRows() {
  if (expandRowsInitialized) return;
  expandRowsInitialized = true;

  document.addEventListener('click', (e) => {
    // Hall of Fame nests a PhotoGrid's lightbox buttons inside its
    // data-expand-row summary row — without this guard, clicking a photo to
    // enlarge it would also toggle the row open/closed underneath the
    // lightbox overlay. lightbox.ts's own listener still fires normally.
    if ((e.target as HTMLElement).closest('[data-lightbox]')) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row]');
    if (row) toggleExpandRow(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if ((e.target as HTMLElement).closest('[data-lightbox]')) return;
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
