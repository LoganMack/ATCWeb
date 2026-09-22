/**
 * Hall of Fame's per-card Overall/Alpha/Gamma/Delta stat filter (per
 * Logan) — hall-of-fame/fragment.astro renders all four class variants of
 * each member's stat block server-side (data-hof-stats-panel="Overall" |
 * "Alpha" | "Gamma" | "Delta"), with only the default one visible; this
 * just shows/hides them on click, scoped to whichever card's own
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
  card.querySelectorAll<HTMLButtonElement>('[data-hof-class-btn]').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.hofClassValue === key);
  });
  card.querySelectorAll<HTMLElement>('[data-hof-stats-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.hofStatsPanel !== key);
  });
}

function initHofClassFilter() {
  if (hofClassFilterInitialized) return;
  hofClassFilterInitialized = true;

  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-hof-class-btn]');
    if (!btn) return;
    const card = btn.closest<HTMLElement>('[data-hof-card]');
    const key = btn.dataset.hofClassValue;
    if (!card || !key) return;
    applyHofClassFilter(card, key);
  });
}

initHofClassFilter();
document.addEventListener('astro:page-load', initHofClassFilter);
