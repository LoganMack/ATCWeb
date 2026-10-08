/**
 * Circuits page's per-row lazy detail load (per Logan's circuits-list
 * refactor) — src/pages/circuits.astro renders one [data-expand-row]/
 * [data-detail-row] <tr> pair per layout (see expandRows.ts for that
 * generic show/hide toggle), but the detail row starts out holding just a
 * "Loading…" placeholder rather than the actual history sections. This
 * script fetches the real content, once, the first time a row is actually
 * expanded, from src/pages/circuits/layout-detail/[layoutId].astro (a
 * plain HTML fragment, not JSON — same "fetch + container.innerHTML ="
 * pattern hall-of-fame.astro/driver-stats.astro use for their own
 * fetched-fragment shells, just triggered per-row on demand here instead
 * of once for the whole page on load).
 *
 * Deliberately lazy rather than rendered server-side for every row up
 * front: the per-layout queries that fragment route runs (findRoundsForLayout,
 * getLayoutClassBestLaps, getLayoutClassHighlights, getPenaltiesForSubsessions,
 * getRaceLinksForSubsessions) are exactly the ones circuits.astro's own
 * comments already documented as "far too expensive" to run once per
 * layout on a page listing every layout at once — see that file's own
 * top-of-frontmatter comment.
 *
 * This is a SEPARATE delegated listener from expandRows.ts's own click/
 * keydown handlers, not a modification of them — expandRows.ts stays
 * generic (just toggles visibility for ANY [data-expand-row]/
 * [data-detail-row] pair site-wide) and knows nothing about fetching.
 * Doesn't depend on which of the two listeners runs first: it reads the
 * row's aria-expanded after the event has finished (see maybeLoad), by which
 * point expandRows.ts has flipped it. (An earlier version assumed this
 * script was registered second; the production bundle reorders them, so the
 * first click read a stale value and the row sat on "Loading…" forever.)
 */
let circuitLayoutDetailInitialized = false;

async function loadLayoutDetail(row: HTMLElement) {
  const url = row.dataset.layoutDetailUrl;
  const detail = row.nextElementSibling as HTMLElement | null;
  const body = detail?.querySelector<HTMLElement>('[data-layout-detail-body]');
  if (!url || !body || row.dataset.detailLoaded === 'true') return;
  // Set before the fetch resolves, not after — a rapid double-click/
  // double-Enter on the same row (or a click that lands while a slow
  // fetch is still in flight) would otherwise fire a second fetch before
  // the guard is ever set.
  row.dataset.detailLoaded = 'true';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    body.innerHTML = await res.text();
  } catch (err) {
    console.error('Failed to load circuit layout detail:', err);
    body.innerHTML = '<p class="text-white/40">Couldn’t load this layout’s history right now.</p>';
    // Allow a retry on the next expand rather than leaving the row stuck
    // showing a permanent error.
    row.dataset.detailLoaded = 'false';
  }
}

function maybeLoad(row: HTMLElement) {
  // Wait for the current event to finish before reading aria-expanded: expandRows.ts flips it in its own
  // listener on the same event, and the production bundler doesn't keep the two scripts in document order,
  // so this listener can run FIRST and would otherwise see the stale (still-collapsed) value and never load.
  setTimeout(() => {
    if (row.getAttribute('aria-expanded') === 'true') loadLayoutDetail(row);
  }, 0);
}

function initCircuitLayoutDetail() {
  if (circuitLayoutDetailInitialized) return;
  circuitLayoutDetailInitialized = true;

  document.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row][data-layout-detail-url]');
    if (row) maybeLoad(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row][data-layout-detail-url]');
    if (row) maybeLoad(row);
  });
}

initCircuitLayoutDetail();
document.addEventListener('astro:page-load', initCircuitLayoutDetail);
