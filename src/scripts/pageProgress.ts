/**
 * Top-of-page progress bar for server round trips the client router doesn't show: from
 * astro:before-preparation to astro:page-load, and through `beforeunload` for hard navigations.
 * hard-form-submit.ts drives it directly around its own fetch. Client-only actions (search, sorting) don't
 * show it.
 */

const COLOR = '#4369F5'; // brand.primary, same blue as everything else on the site
const SAFETY_TIMEOUT_MS = 15000; // guards against a hung/failed request leaving the bar stuck forever

let bar: HTMLDivElement | null = null;
let visible = false;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function ensureBar(): HTMLDivElement {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'page-progress-bar';
  bar.setAttribute('aria-hidden', 'true');
  bar.style.position = 'fixed';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.height = '3px';
  bar.style.width = '0%';
  bar.style.zIndex = '9999';
  bar.style.backgroundColor = COLOR;
  bar.style.opacity = '0';
  bar.style.pointerEvents = 'none';
  document.body.appendChild(bar);
  return bar;
}

function clearTimers() {
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

export function showProgress() {
  const el = ensureBar();
  clearTimers();
  visible = true;

  if (reducedMotion()) {
    // Still show *that* something is loading, just without any animated
    // motion — jump straight to a static partial bar.
    el.style.transition = 'none';
    el.style.width = '70%';
    el.style.opacity = '1';
  } else {
    // Reset instantly (no transition) so a second navigation fired before
    // the first one finished reads as a fresh trip, not a stalled one
    // continuing from wherever it left off.
    el.style.transition = 'none';
    el.style.width = '0%';
    el.style.opacity = '1';
    // Force a reflow so the width change below actually animates instead
    // of collapsing into the instant reset above.
    void el.offsetWidth;
    el.style.transition = 'width 4s cubic-bezier(0.1, 0.6, 0.2, 1), opacity 0.2s ease';
    requestAnimationFrame(() => {
      if (!visible || !bar) return;
      bar.style.width = '85%';
    });
  }

  // A stuck request (offline, a server that never responds, an error page
  // that never fires astro:page-load) shouldn't leave a permanent loading
  // bar on screen — clear it out after a while regardless.
  safetyTimer = setTimeout(() => hideProgress(), SAFETY_TIMEOUT_MS);
}

export function hideProgress() {
  if (!bar || !visible) return;
  visible = false;
  clearTimers();

  const el = bar;
  if (reducedMotion()) {
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.width = '0%';
    return;
  }

  el.style.transition = 'width 0.2s ease, opacity 0.3s ease';
  el.style.width = '100%';
  hideTimer = setTimeout(() => {
    el.style.opacity = '0';
    hideTimer = setTimeout(() => {
      el.style.width = '0%';
    }, 300);
  }, 150);
}

document.addEventListener('astro:before-preparation', showProgress);
document.addEventListener('astro:page-load', hideProgress);
window.addEventListener('beforeunload', showProgress);
