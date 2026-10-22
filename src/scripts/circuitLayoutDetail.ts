/**
 * Circuits page: loads a layout row's detail fragment (circuits/layout-detail/[layoutId]) the first time it's
 * expanded, because those per-layout queries are too costly to run for every layout up front. Separate from
 * expandRows.ts, which only toggles visibility; it reads aria-expanded after the event, so listener order
 * doesn't matter.
 */
let circuitLayoutDetailInitialized = false;

async function loadLayoutDetail(row: HTMLElement) {
  const url = row.dataset.layoutDetailUrl;
  const detail = row.nextElementSibling as HTMLElement | null;
  const body = detail?.querySelector<HTMLElement>('[data-layout-detail-body]');
  if (!url || !body || row.dataset.detailLoaded === 'true') return;
  // Marked before the fetch resolves, so a double click can't start a second fetch.
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
