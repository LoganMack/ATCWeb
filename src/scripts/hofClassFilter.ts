/**
 * Hall of Fame's per-card Overall/Alpha/Gamma/Delta stat dropdown (per
 * Logan) — hall-of-fame/fragment.astro renders all four class variants of
 * each member's stat block server-side (data-hof-stats-panel="Overall" |
 * "Alpha" | "Gamma" | "Delta"), with only the default one visible; this
 * just shows/hides them when the card's dropdown changes, scoped to whichever card's own
 * [data-hof-card] ancestor the clicked button lives in, so one card's
 * filter never affects another's.
 *
 * Delegated on `document`, same reasoning as expandRows.ts: the fragment
 * is injected via `container.innerHTML` well after this script's own
 * module-level code runs (see hall-of-fame.astro), so a listener bound
 * directly to each button at that point would never see it — delegation
 * resolves fresh against whatever's in the DOM at click time regardless of
 * when it appeared. The de-dup guard is the same plain module-scoped
 * variable expandRows.ts uses, for the same reason: `document` itself is
 * never replaced by Astro's client router (unlike `document.body`), so a
 * flag bound here survives every soft navigation and this only ever binds
 * once for the page's whole lifetime.
 */
let hofClassFilterInitialized = false;

function applyHofClassFilter(card: HTMLElement, key: string) {
  const select = card.querySelector<HTMLSelectElement>('[data-hof-class-select]');
  if (select && select.value !== key) select.value = key;
  card.querySelectorAll<HTMLElement>('[data-hof-stats-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.hofStatsPanel !== key);
  });
}

function initHofClassFilter() {
  if (hofClassFilterInitialized) return;
  hofClassFilterInitialized = true;

  document.addEventListener('change', (e) => {
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-hof-class-select]');
    if (!select) return;
    const card = select.closest<HTMLElement>('[data-hof-card]');
    if (!card) return;
    applyHofClassFilter(card, select.value);
  });
}

initHofClassFilter();
document.addEventListener('astro:page-load', initHofClassFilter);
