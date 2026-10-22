/**
 * "Add to Calendar" buttons: each carries ready VEVENT text in `data-ics-event` (src/lib/ics.ts); this only
 * wraps it and downloads a Blob, with no request. One delegated listener on `document`, bound once.
 */
function wrapVCalendar(veventBlocks: string): string {
  const CRLF = '\r\n';
  // Attribute values arrive with LF line ends, so this is the one place they become the CRLF RFC 5545
  // requires.
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
