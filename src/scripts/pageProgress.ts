/**
 * A thin progress bar fixed to the top of the viewport, shown for the
 * duration of any server round trip that Astro's client router doesn't
 * otherwise indicate — clicking a nav link, changing a season/class filter
 * dropdown, or paging through a list all fetch + swap the page, but
 * nothing on screen shows a request is in flight until the new content
 * lands. On anything slower than instant that reads as "did my click even
 * register?", which is exactly what got reported.
 *
 * Wired to two router lifecycle events (astro:before-preparation fires the
 * instant a soft navigation starts, astro:page-load fires once the new
 * page has been swapped in and initialized) plus `beforeunload`, which
 * covers hard navigations the router doesn't intercept at all (external
 * links, `data-astro-reload`, the very first load of a session, etc.) —
 * the bar just stays visible through the reload since the page is about
 * to be replaced anyway.
 *
 * hard-form-submit.ts calls showProgress()/hideProgress() directly around
 * its own fetch(), since that request is deliberately built to bypass the
 * router entirely (see the comment there) and so is invisible to both
 * events above.
 *
 * Deliberately NOT wired to anything purely client-side — search-box
 * filtering and sortable-table column clicks never touch the network, so
 * there's nothing to indicate and no listener here fires for them.
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
