/**
 * Click-to-expand for `<tr data-expand-row>` + the following `<tr data-detail-row>`, site-wide. One delegated
 * listener on `document`, bound once per page lifetime. The guard is a module variable, not a `document.body`
 * flag: the client router replaces body on every navigation, so a body flag let listeners stack up and a
 * click toggled twice (looking like nothing happened).
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
    // Lightbox and Hall of Fame class-filter buttons inside a summary row must not also toggle the row.
    if ((e.target as HTMLElement).closest('[data-lightbox]')) return;
    if ((e.target as HTMLElement).closest('[data-hof-class-select]')) return;
    // A driver's name inside the row links to their profile — follow it instead of toggling the row.
    if ((e.target as HTMLElement).closest('a.driver-link')) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row]');
    if (row) toggleExpandRow(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if ((e.target as HTMLElement).closest('[data-lightbox]')) return;
    if ((e.target as HTMLElement).closest('[data-hof-class-select]')) return;
    if ((e.target as HTMLElement).closest('a.driver-link')) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-expand-row]');
    if (!row) return;
    e.preventDefault();
    toggleExpandRow(row);
  });
}

// Runs now (the script is at the end of <body>) and on every astro:page-load as a backstop; the guard makes
// both safe.
initExpandRows();
document.addEventListener('astro:page-load', initExpandRows);
