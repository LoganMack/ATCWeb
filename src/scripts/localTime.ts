/**
 * Re-renders every `[data-utc-time]` in the viewer's time zone with the zone abbreviation (e.g. "8:00 PM
 * PDT"); the server's Eastern text is the no-JS fallback. Client-side because pages are edge-cached and
 * shared across time zones.
 */
function initLocalTime() {
  document.querySelectorAll<HTMLElement>('[data-utc-time]').forEach((el) => {
    const iso = el.dataset.utcTime;
    if (!iso) return;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    el.textContent = date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  });
}

// Run now as well: a page that first loads this script on a client-side navigation may execute it after
// that navigation's astro:page-load.
initLocalTime();
document.addEventListener('astro:page-load', initLocalTime);
