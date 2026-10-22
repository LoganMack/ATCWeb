/**
 * Hall of Fame card stat filter (Overall/Alpha/Gamma/Delta): all four panels are rendered and this shows the
 * chosen one within its own [data-hof-card]. Delegated on `document`, bound once with a module guard like
 * expandRows.ts, because the cards arrive in a fetched fragment.
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
