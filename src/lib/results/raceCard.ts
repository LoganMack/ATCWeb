/**
 * The round results page's race summary card (FR3.4-FR3.7; BR3.4-BR3.7): Date, Grid Size, SOF, Race Time (race
 * views only) and Wet Affected for the one session in view. Pure: the fragment passes the rows it already
 * loaded and the event's wet flags.
 */
import { formatDate } from '../db/circuits';
import type { EventWetFlags } from '../db/events';
import { overallRaceTimeTenThousandths } from './raceDisplay';

/** The session the page shows (`?session=`). */
export type CardSession =
  { kind: 'race'; raceNumber: number } | { kind: 'qualifying' } | { kind: 'practice' };

/** The fields of a results row the card reads (RaceResultRow in roundResults.ts has them all). */
export interface CardResultRow {
  position: number | null;
  dsq: boolean;
  tags: string[];
  driver: { id: string };
  laps: number | null;
  averageLapTenThousandths: number | null;
}

const MISSING = '—';
const UNROSTERED_ID_PREFIX = 'unrostered:';

/**
 * A duration as "H:MM:SS", or "MM:SS" under an hour (BR3.6), rounded to whole seconds. Hours may exceed 24.
 * "—" when unknown.
 */
export function formatDuration(tenThousandths: number | null): string {
  if (tenThousandths === null || !Number.isFinite(tenThousandths) || tenThousandths < 0) return MISSING;
  const totalSeconds = Math.round(tenThousandths / 10000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/**
 * Grid Size (BR3.4): the round's num_drivers when set, else the number of different entrants with a race
 * result in the round (unrostered ones included). Null when that is zero.
 */
export function gridSize(
  numDrivers: number | null,
  roundRows: Iterable<{ driver: { id: string } }>,
): number | null {
  if (numDrivers !== null && numDrivers > 0) return numDrivers;
  const entrants = new Set<string>();
  for (const row of roundRows) entrants.add(row.driver.id);
  return entrants.size > 0 ? entrants.size : null;
}

/**
 * The race winner (BR3.5): the scored driver shown in position 1, classified and not disqualified. Unrostered
 * entrants are never scored, so they never win.
 */
export function raceWinner<T extends CardResultRow>(overallRows: T[]): T | null {
  return (
    overallRows.find(
      (row) =>
        row.position === 1 &&
        !row.dsq &&
        !row.tags.includes('Unclassified') &&
        !row.driver.id.startsWith(UNROSTERED_ID_PREFIX),
    ) ?? null
  );
}

/** The winner's laps times their average lap, on track only: time penalties are not added (BR3.5). */
export function winnerRaceTime(overallRows: CardResultRow[]): number | null {
  const winner = raceWinner(overallRows);
  if (!winner || !winner.laps || !winner.averageLapTenThousandths) return null;
  return overallRaceTimeTenThousandths(winner.laps, winner.averageLapTenThousandths, 0);
}

/** The wet flag for the session in view; false when the round has no event (BR3.7). */
export function wetAffectedFor(session: CardSession, flags: EventWetFlags | null): boolean {
  if (!flags) return false;
  if (session.kind === 'practice') return flags.practice_wet_affected === true;
  if (session.kind === 'qualifying') return flags.qualifying_wet_affected === true;
  const key = `race${session.raceNumber}_wet_affected` as const;
  return key in flags ? (flags as unknown as Record<string, boolean>)[key] === true : false;
}

export interface RaceCardView {
  date: string;
  gridSize: string;
  sof: string;
  /** Null outside race views, where the card has no Race Time. */
  raceTime: string | null;
  wetAffected: 'Yes' | 'No';
}

/** Everything the card shows, formatted, for the session in view. */
export function buildRaceCard(input: {
  startTime: string;
  numDrivers: number | null;
  strengthOfField: number | null;
  session: CardSession;
  /** Every race's overall rows in the round, for the Grid Size fallback. */
  roundRows: Iterable<{ driver: { id: string } }>;
  /** The overall rows of the race in view (ignored outside race views). */
  raceRows: CardResultRow[];
  wetFlags: EventWetFlags | null;
}): RaceCardView {
  const grid = gridSize(input.numDrivers, input.roundRows);
  return {
    date: formatDate(input.startTime),
    gridSize: grid === null ? MISSING : String(grid),
    sof:
      input.strengthOfField !== null && input.strengthOfField > 0 ? String(input.strengthOfField) : MISSING,
    raceTime: input.session.kind === 'race' ? formatDuration(winnerRaceTime(input.raceRows)) : null,
    wetAffected: wetAffectedFor(input.session, input.wetFlags) ? 'Yes' : 'No',
  };
}
