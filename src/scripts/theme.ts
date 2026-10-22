/**
 * Light/dark toggle for the footer button, saved in localStorage. Dark is the default and light is
 * `.light`-scoped CSS, so this only toggles the class; the before-paint step is the inline script in
 * Layout.astro. Re-runs after each view transition because the footer is swapped in fresh.
 */
const THEME_STORAGE_KEY = 'atc-theme';

function isLight(): boolean {
  return document.documentElement.classList.contains('light');
}

function initThemeToggle() {
  const btn = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!btn) return;
  // astro:page-load fires again on pages that load their content as a
  // fragment (the loader scripts re-dispatch it); without this guard the
  // button got a second click listener and every click toggled twice.
  if (btn.dataset.themeInit === 'true') return;
  btn.dataset.themeInit = 'true';

  function updateButton() {
    const light = isLight();
    btn!.setAttribute('aria-pressed', String(light));
    btn!.title = light ? 'Switch to dark mode' : 'Switch to light mode';
  }

  updateButton();

  btn.addEventListener('click', () => {
    const next = !isLight();
    document.documentElement.classList.toggle('light', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next ? 'light' : 'dark');
    } catch {
      // localStorage unavailable (private browsing, blocked storage, etc.)
      // — the toggle still works for this page view, it just won't be
      // remembered next visit.
    }
    updateButton();
  });
}

document.addEventListener('astro:page-load', initThemeToggle);

// The view-transition swap copies the incoming <html> attributes, which never include the client-only
// `.light`, so it is re-applied on the incoming document in astro:before-swap.
document.addEventListener('astro:before-swap', (event) => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const swapEvent = event as unknown as { newDocument: Document };
    swapEvent.newDocument.documentElement.classList.toggle('light', stored === 'light');
  } catch {
    // localStorage unavailable — nothing to restore, leave the incoming
    // document's class as Astro already computed it.
  }
});
