/**
 * "Add to Calendar" buttons — one per event card, plus a bulk "add every
 * upcoming event" button on the Calendar page and homepage. Each button
 * carries its already-built VEVENT text (or, for a bulk button, several
 * VEVENT blocks already joined) in a `data-ics-event` attribute — see
 * src/lib/ics.ts for how that text gets built server-side at render time.
 * This script only ever does the trivial "wrap in VCALENDAR, hand to a
 * Blob, trigger a download" step — no network round trip, so it costs
 * nothing against the Cloudflare Workers budget those .astro pages already
 * have to be careful about (see the Standings page's Error 1102 fix).
 *
 * One delegated `click` listener on `document`, bound once — same
 * de-dup-via-`document.body.dataset` convention as src/scripts/expandRows.ts
 * and sortable-table.ts, so this never needs special handling across a view
 * transition either.
 */
function wrapVCalendar(veventBlocks: string): string {
  const CRLF = '\r\n';
  // The incoming veventBlocks text came through an HTML data attribute —
  // browsers normalize any CR/CRLF in an attribute value down to a bare LF
  // on parse (see src/lib/ics.ts's own header comment on why it only ever
  // writes '\n' in the first place) — so this is the one place that turns
  // every line ending, however it arrived, into the real CRLF RFC 5545
  // actually wants in the downloaded bytes.
  return (
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Alpha Touring Challenge//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      veventBlocks,
      'END:VCALENDAR',
    ]
      .join(CRLF)
      .replace(/\r\n|\r|\n/g, CRLF) + CRLF
  );
}

function downloadIcs(veventBlocks: string, filename: string) {
  const ics = wrapVCalendar(veventBlocks);
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not immediate — some browsers need the download to actually
  // start reading the blob URL before it's revoked out from under it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initAddToCalendar() {
  if (document.body.dataset.addToCalendarInit === 'true') return;
  document.body.dataset.addToCalendarInit = 'true';

  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ics-download]');
    if (!btn) return;
    const veventBlocks = btn.dataset.icsEvent;
    if (!veventBlocks) return;
    const filename = btn.dataset.icsFilename || 'alpha-touring-challenge.ics';
    downloadIcs(veventBlocks, filename);
  });
}

initAddToCalendar();
document.addEventListener('astro:page-load', initAddToCalendar);
