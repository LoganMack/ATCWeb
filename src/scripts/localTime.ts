/**
 * Re-renders every `[data-utc-time]` element in the viewer's own local
 * timezone. Server-rendered content already shows the correct instant
 * labeled as Eastern (see src/lib/timezone.ts/eventFormatting.ts) — that's
 * a safe, always-correct fallback for no-JS and for the first paint before
 * this runs. Once this runs, it replaces that text with the same instant
 * formatted in whichever timezone the browser reports, with the zone
 * abbreviation appended (e.g. "8:00 PM PDT") so it's obvious the time has
 * already been converted rather than still being Eastern.
 *
 * This has to happen client-side, not server-side: pages showing these
 * times are edge-cached and shared across visitors in different
 * timezones (see Cache-Control on calendar.astro/index.astro), so a
 * server-side conversion could only ever be correct for whichever visitor
 * happened to generate the cached copy.
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

document.addEventListener('astro:page-load', initLocalTime);
