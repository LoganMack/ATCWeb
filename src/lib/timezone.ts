/**
 * Every event session time in this app (`events.practice_start_time`,
 * `race1_start_time`, etc.) is stored as a plain `'HH:MM:SS'` wall-clock
 * string with no date or timezone attached to it — and every one of those
 * values was entered assuming the league operates on US Eastern time
 * (America/New_York, which auto-handles the EDT/EST switch). That was
 * always implicit, never actually enforced or converted anywhere: the site
 * just echoed the raw digits back, so a visitor in a different timezone
 * saw the wrong wall-clock time for when a race actually starts.
 *
 * This file is the one place that encodes "times are Eastern" as an
 * explicit constant + a real timezone-aware conversion, so every page that
 * shows a session time can turn it into a real UTC instant — from there,
 * `src/scripts/localTime.ts` (loaded globally, see Layout.astro) re-renders
 * that instant in whatever timezone the VIEWER's own browser is in.
 *
 * Deliberately NOT applied to `_sim_time` fields — those are iRacing's own
 * simulated clock (affects in-game lighting/weather), which has no
 * real-world timezone at all; see EventRecord's own doc comment.
 *
 * Pure vanilla `Intl`/`Date` — no dependency, and works identically
 * server-side (Cloudflare Workers' runtime, which runs in UTC) and
 * client-side (the viewer's own browser), which matters here since pages
 * showing these times are edge-cached (`Cache-Control: s-maxage=60,
 * stale-while-revalidate=300`) and shared across visitors in different
 * timezones — the actual per-viewer conversion has to happen in the
 * browser, not on the server, or every visitor after the first would see
 * whichever timezone rendered the cached copy.
 */

export const LEAGUE_TIME_ZONE = 'America/New_York';

/**
 * Converts a wall-clock date + time in `timeZone` into the real UTC instant
 * it represents, correctly handling that timezone's DST rules for that
 * specific date (e.g. a January time is EST/UTC-5, a July time is
 * EDT/UTC-4 — this figures out which applies rather than assuming one).
 *
 * Standard "guess UTC, ask what that guess displays as in the target zone,
 * correct by the difference" technique — reliable without a timezone
 * database dependency, since `Intl.DateTimeFormat` already carries one.
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
    Number(parts.second)
  );

  // asIfLocalMs is what the guess LOOKS LIKE when read as a `timeZone` wall
  // clock; the gap between that and the guess itself is exactly the
  // zone's UTC offset at this instant (DST-correct, since it's derived
  // from the actual date in question).
  const offsetMs = guessUtcMs - asIfLocalMs;
  return new Date(guessUtcMs + offsetMs);
}

/** Same as `zonedTimeToUtc`, returned as an ISO string (or null) — the shape every caller in this app actually wants, to embed in a `data-utc-time` attribute. */
export function zonedTimeToUtcIso(dateStr: string | null | undefined, timeStr: string | null | undefined, timeZone: string): string | null {
  if (!dateStr || !timeStr) return null;
  const d = zonedTimeToUtc(dateStr, timeStr, timeZone);
  return d ? d.toISOString() : null;
}
