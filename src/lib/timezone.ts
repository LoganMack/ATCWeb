/**
 * Session times are stored as bare 'HH:MM:SS' entered in US Eastern time (America/New_York). This converts
 * them to real UTC instants; src/scripts/localTime.ts then shows them in the viewer's zone in the browser,
 * because pages are edge-cached and shared across time zones. Not for `_sim_time` fields, which are iRacing's
 * in-game clock.
 */

export const LEAGUE_TIME_ZONE = 'America/New_York';

/**
 * A wall-clock date + time in `timeZone` as a UTC instant, using that date's DST offset: guess UTC, see how
 * the guess reads in the zone, correct by the difference (Intl carries the zone data).
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr);
  if (!dateMatch || !timeMatch) return null;

  const [, y, mo, d] = dateMatch.map(Number) as unknown as [number, number, number, number];
  const [, hh, mm, ss] = timeMatch.map((v) => (v === undefined ? 0 : Number(v))) as unknown as [
    number,
    number,
    number,
    number,
  ];

  const guessUtcMs = Date.UTC(y, mo - 1, d, hh, mm, ss);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guessUtcMs)).map((p) => [p.type, p.value]));
  // Some ICU implementations render midnight as "24" for a 2-digit hour-12=false format — normalize back to 0.
  const hourPart = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asIfLocalMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hourPart,
    Number(parts.minute),
    Number(parts.second),
  );

  // The gap between the guess and how it reads in `timeZone` is the zone's offset on that date.
  const offsetMs = guessUtcMs - asIfLocalMs;
  return new Date(guessUtcMs + offsetMs);
}

/** Same as `zonedTimeToUtc`, returned as an ISO string (or null) — the shape every caller in this app actually wants, to embed in a `data-utc-time` attribute. */
export function zonedTimeToUtcIso(
  dateStr: string | null | undefined,
  timeStr: string | null | undefined,
  timeZone: string,
): string | null {
  if (!dateStr || !timeStr) return null;
  const d = zonedTimeToUtc(dateStr, timeStr, timeZone);
  return d ? d.toISOString() : null;
}
