/**
 * Minimal iCalendar (RFC 5545) text for the "Add to Calendar" buttons, built at render time from data the
 * page already has and embedded on each card; src/scripts/addToCalendar.ts wraps and downloads it, so a click
 * costs no Worker CPU or request. Lines use '\n' because HTML attributes normalise CR anyway; the client
 * converts to CRLF last.
 */
import type { EventWithCircuit } from './db/events';
import type { CircuitLayout } from './db/circuits';
import { displayLayoutName } from './db/circuits';
import { getEventSessions, formatSessionTime } from './eventFormatting';

const NL = '\n';

/** Escapes TEXT-valued content per RFC 5545 §3.3.11 — backslash first, so the escapes added for the others don't themselves get re-escaped. */
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds one logical content line to <=75 octets per line per RFC 5545 §3.1, continuation lines prefixed with a single space. Assumes ASCII-ish content (driver/circuit names in this app always are), so octet count == character count here. */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    chunks.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return chunks.join(NL);
}

/** A single "KEY:value" (or "KEY;PARAM=x:value") content line, folded. */
function line(key: string, value: string): string {
  return foldIcsLine(`${key}:${value}`);
}

/** 'YYYYMMDDTHHMMSSZ' from an ISO instant — the DATE-TIME form RFC 5545 wants for a UTC time. */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * One VEVENT (no wrapper) covering every scheduled session, or null when nothing is timed (a test session
 * with no races, 0054), in which case the button isn't shown. DTEND is the last session start plus 2 hours,
 * since session lengths aren't reliably recorded.
 */
export function buildEventIcsBlock(
  event: EventWithCircuit,
  layouts: Pick<CircuitLayout, 'circuit_id' | 'name' | 'image_url'>[],
): string | null {
  const sessions = getEventSessions(event);
  const timed = sessions.filter((s) => s.startTimeUtcIso !== null);
  if (timed.length === 0) return null;

  const startMs = Math.min(...timed.map((s) => new Date(s.startTimeUtcIso!).getTime()));
  const lastStartMs = Math.max(...timed.map((s) => new Date(s.startTimeUtcIso!).getTime()));
  const endMs = Math.max(lastStartMs + 2 * 60 * 60 * 1000, startMs + 2 * 60 * 60 * 1000);

  const circuitName = event.title ?? event.circuits?.name ?? 'TBA';
  const layoutName = event.layout ? displayLayoutName(event.layout) : null;
  const summary = `ATC — ${circuitName}${layoutName ? ` (${layoutName})` : ''}`;

  const descriptionParts: string[] = [];
  if (event.season_id && event.round_number !== null) {
    descriptionParts.push(`${event.seasons?.name ?? 'Season'} — Round ${event.round_number}`);
  }
  for (const s of sessions) {
    descriptionParts.push(
      `${s.label}: ${s.startTime ? `${formatSessionTime(s.startTime)} ET` : 'TBD'}${s.detail ? ` (${s.detail})` : ''}`,
    );
  }
  descriptionParts.push('https://alphatouringchallenge.com/calendar');

  const uid = `atc-event-${event.id}@alphatouringchallenge.com`;
  const now = toIcsUtc(new Date().toISOString());

  return [
    'BEGIN:VEVENT',
    line('UID', uid),
    line('DTSTAMP', now),
    line('DTSTART', toIcsUtc(new Date(startMs).toISOString())),
    line('DTEND', toIcsUtc(new Date(endMs).toISOString())),
    line('SUMMARY', escapeIcsText(summary)),
    line('LOCATION', escapeIcsText(circuitName)),
    line('DESCRIPTION', escapeIcsText(descriptionParts.join('\n'))),
    line('URL', 'https://alphatouringchallenge.com/calendar'),
    'END:VEVENT',
  ].join(NL);
}

/**
 * Wraps VEVENT blocks in a VCALENDAR with CRLF line ends. Unused by the browser flow (addToCalendar.ts has
 * its own copy); kept for a server-side consumer.
 */
export function wrapVCalendar(veventBlocks: string): string {
  const CRLF = '\r\n';
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
      .join(NL)
      .replace(/\r\n|\r|\n/g, CRLF) + CRLF
  );
}
