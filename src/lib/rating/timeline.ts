/**
 * The shared round timeline of the Series iRating charts: one slot per rated round (a positive subsession id
 * in a main ATC season), in round order, minus test and exhibition rounds. Every driver's chart uses the same
 * slots, so season labels line up across drivers. Pure: the reader in src/lib/db/seriesRatings.ts passes the rows and
 * the excluded ids.
 */
import type { RoundEventEmbed } from '../results/roundEligibility';

/** One slot: i the round's subsession id (the key a history point matches), s its season name ('' if none). */
export interface TimelineSlot {
  i: number;
  s: string;
}

export type TimelineRoundRow = { subsession_id: number; season: { name: string } | null } & RoundEventEmbed;

/**
 * A main league season is named "ATC" plus its number. Side series that live in the seasons table (ATC
 * Exhibitions, ATC4 Off-Season Fun Series, LCC1) carry other names and stay off the chart.
 */
export function isMainSeasonName(name: string | null | undefined): boolean {
  return typeof name === 'string' && /^ATC\d+$/.test(name.trim());
}

/**
 * Rows in the order given, minus excluded ids and rounds outside a main season, as { i, s }. Never reorders and
 * never changes its inputs.
 */
export function buildTimelineSlots(
  rows: readonly TimelineRoundRow[],
  excluded: ReadonlySet<number>,
): TimelineSlot[] {
  const slots: TimelineSlot[] = [];
  for (const row of rows) {
    const season = row.season?.name;
    if (excluded.has(row.subsession_id) || !season || !isMainSeasonName(season)) continue;
    slots.push({ i: row.subsession_id, s: season.trim() });
  }
  return slots;
}
