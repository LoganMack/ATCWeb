/**
 * Light/dark theme toggle — wires up the footer button's click handling
 * and keeps localStorage in sync. The FOUC-prevention piece (applying the
 * saved preference to <html> before first paint) is a separate inline
 * script in Layout.astro's <head>, since this module-script file loads and
 * runs too late for that job. Dark is the default/unprefixed styling site
 * wide; light mode is 100% additive `.light`-scoped CSS in global.css, so
 * all this needs to do is toggle that one class and persist the choice.
 *
 * Re-runs after each Astro view transition since the footer (and its
 * button) gets swapped in fresh on every navigation — same convention as
 * reveal.ts and the rest of src/scripts.
 */
const THEME_STORAGE_KEY = 'atc-theme';

function isLight(): boolean {
  return document.documentElement.classList.contains('light');
}

function initThemeToggle() {
  const btn = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!btn) return;

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

// Astro's view-transition swap copies the INCOMING page's <html> attributes
// onto the current document as part of the swap — and since `.light` is a
// client-only preference (never server-rendered; theme.ts and the
// FOUC-prevention inline script in Layout.astro are the only things that
// ever add it), the incoming document never has it, so every soft
// navigation was silently wiping it back to dark. `astro:before-swap` fires
// with the incoming document still just an in-memory DOM (before it
// replaces the current one), so re-applying the saved preference there
// keeps it correct through the swap with no flash — the same document
// Astro is about to swap in already has the right class by the time it
// lands.
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
