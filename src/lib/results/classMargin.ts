/**
 * The driver profile Races table's Class margin (BR3.3): the gap to the race's class leader, measured exactly as
 * the results page's Per Class view does (roundResults.ts), plus a sort value for any margin text (BR3.4).
 */
import { formatMargin } from './format';

/** One driver's scored row in a race: their class, pre-penalty finishing slot and DSQ flag. */
export interface ClassLeaderFieldRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  finish_position: number;
  dsq: boolean;
}

/**
 * `${subsessionId}:${raceNumber}:${classId}` -> the class leader's driver id: the non-DSQ driver of that class
 * with the lowest pre-penalty finish_position. A class whose every driver is DSQ has no entry.
 */
export function classLeaders(field: readonly ClassLeaderFieldRow[]): Map<string, string> {
  const best = new Map<string, ClassLeaderFieldRow>();
  for (const row of field) {
    if (row.dsq) continue;
    const key = `${row.subsession_id}:${row.race_number}:${row.class_id}`;
    const current = best.get(key);
    if (!current || row.finish_position < current.finish_position) best.set(key, row);
  }
  return new Map([...best].map(([key, row]) => [key, row.driver_id]));
}

interface MarginRaw {
  interval_ten_thousandths: number | null;
  laps_complete: number | null;
}

/**
 * The class margin text: against the class leader's raw result when there is one, else against the overall
 * leader (`overallLeaderLaps`), as the Per Class view does when the whole class is DSQ.
 */
export function classMarginText(
  own: MarginRaw,
  classLeader: MarginRaw | null,
  overallLeaderLaps: number | null,
): string {
  if (classLeader) {
    return formatMargin(
      own.interval_ten_thousandths,
      own.laps_complete,
      classLeader.laps_complete,
      classLeader.interval_ten_thousandths,
    );
  }
  return formatMargin(own.interval_ten_thousandths, own.laps_complete, overallLeaderLaps);
}

/**
 * A sortable number for a margin's text: seconds as they are, laps down after every timed gap, and null for
 * "—" (the leader or a missing time), which sorts last.
 */
export function marginSortValue(text: string): number | null {
  const lapped = /^-(\d+)L$/.exec(text);
  if (lapped) return 1_000_000 + Number(lapped[1]);
  const seconds = Number(text);
  return text.trim() !== '' && Number.isFinite(seconds) ? seconds : null;
}
