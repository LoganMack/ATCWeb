/**
 * Shared formatting for "pick a round" lists and the compact "MMM DD, YYYY"
 * date style used in admin tables and round pickers (the news editor's linked
 * round, the race results page's round dropdown).
 *
 * Dates are rendered in the league's own time zone (Eastern), not the
 * server's (UTC on Cloudflare), so a late-evening race never shows up as the
 * next day.
 */
import { LEAGUE_TIME_ZONE } from './timezone';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LEAGUE_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/** "Sep 05, 2026". Accepts a full timestamp or a plain 'YYYY-MM-DD' date; returns '—' for empty/invalid input. */
export function formatMonthDayYear(input: string | null | undefined): string {
  if (!input) return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  let y: number, m: number, d: number;
  if (dateOnly) {
    [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
  } else {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return '—';
    const parts = partsFormatter.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    [y, m, d] = [get('year'), get('month'), get('day')];
  }
  return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

/** "Sep 05, 2026: Track Name" — the label used in every round dropdown. */
export function roundOptionLabel(round: { start_time: string; track_name: string }): string {
  return `${formatMonthDayYear(round.start_time)}: ${round.track_name}`;
}

export interface RoundGroup<T> {
  label: string;
  rounds: T[];
}

/**
 * Groups rounds by season label. Groups are ordered newest season first (by
 * the most recent round in each) and each group's rounds are newest first.
 */
export function groupRoundsBySeason<T extends { season_label: string | null; start_time: string }>(
  rounds: T[]
): RoundGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rounds) {
    const key = r.season_label ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const time = (r: T) => new Date(r.start_time).getTime();
  return [...groups.entries()]
    .map(([label, rs]) => ({ label, rounds: [...rs].sort((a, b) => time(b) - time(a)) }))
    .sort((a, b) => time(b.rounds[0]) - time(a.rounds[0]));
}
