/**
 * Minimal RFC 5545 (iCalendar) generation for the "Add to Calendar" buttons
 * on event cards (EventDetailCard.astro, UpcomingEventCard.astro) and the
 * calendar/homepage's own "add every upcoming event" bulk buttons.
 *
 * Deliberately built server-side, at render time, from data the page has
 * already fetched — no new API route, no client-side network round trip.
 * Each event's VEVENT text is embedded as a data attribute on its card (see
 * those two components); src/scripts/addToCalendar.ts reads it back out
 * client-side, wraps it in a VCALENDAR, and triggers a plain Blob download.
 * That keeps this feature free (no extra Cloudflare Workers CPU/subrequest
 * cost per click — see the Standings page's Error 1102 fix in the same
 * batch as this feature for why that budget is worth protecting) and means
 * a "download every upcoming event" button is just string concatenation of
 * blocks already sitting in the DOM, not a second server computation.
 *
 * Lines here are joined with plain '\n', not RFC 5545's real CRLF — this
 * text's next stop is an HTML attribute (see the components above), and
 * HTML attribute-value normalization collapses any CR/CRLF down to a bare
 * LF on the way through the DOM regardless of what's written here. The
 * client script does the CRLF normalization at the very last step, right
 * before the actual file bytes get produced, so it's the one place that
 * decides that once, correctly, rather than everyone upstream guessing.
 */
import type { EventWithCircuit, CircuitLayout } from './supabase';
import { displayLayoutName } from './supabase';
import { getEventSessions, formatSessionTime } from './eventFormatting';

const NL = '\n';

/** Escapes TEXT-valued content per RFC 5545 §3.3.11 — backslash first, so the escapes added for the others don't themselves get re-escaped. */
function escapeIcsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
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
 * One VEVENT block (no VCALENDAR wrapper — see this file's header) for a
 * single event, or null when there's genuinely no start time to build one
 * from (getEventSessions() found nothing timed — happens for a Test Session
 * saved with no races at all, see 0054_test_session_no_race_required.sql;
 * every other category still always has at least race1_start_time). The
 * card's "Add to Calendar" button just doesn't render when this is null.
 *
 * The block covers every scheduled session (Practice through Race 3) as one
 * calendar entry rather than one entry per session — DTSTART is the
 * earliest known session start, DTEND is the latest known session start
 * plus a flat 2-hour buffer (the pipeline has no actual session-length data
 * reliable enough to compute a real end time from — see EventRecord's
 * *_minutes/*_laps fields, which aren't consistently filled in — so this is
 * a deliberately generous round-trip estimate, not a precise one).
 */
export function buildEventIcsBlock(
  event: EventWithCircuit,
  layouts: Pick<CircuitLayout, 'circuit_id' | 'name' | 'image_url'>[]
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
    descriptionParts.push(`${s.label}: ${s.startTime ? `${formatSessionTime(s.startTime)} ET` : 'TBD'}${s.detail ? ` (${s.detail})` : ''}`);
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
 * Wraps one or more VEVENT blocks (from buildEventIcsBlock, joined with
 * '\n') in a complete VCALENDAR document. Not used by the browser flow
 * (src/scripts/addToCalendar.ts has its own copy, on the client side where
 * the actual download happens — see this file's header) — kept here for
 * any future server-side-only consumer (e.g. an API route) that wants a
 * ready-to-serve .ics without duplicating this shape itself. Normalizes to
 * real CRLF right at the end, same as the client copy does.
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
