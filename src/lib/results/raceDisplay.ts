import { formatLapTime } from '../db/circuits';
import { effectiveTimePenaltySeconds, type PenaltyLike } from '../penalties/effective';
import { scoringRaceNumber } from '../penalties/reorder';

// Display text for a race's margins, intervals, overall race times and old positions. Positions and
// points come from race_score_results_public; this only formats. Where a round's penalties are
// visible to the reader, gaps and race times use the same inputs and formula the results page has
// always used (curated intervals, laps × average lap, plus each driver's effective time penalty),
// so the text matches it exactly; the view's stored ms values are not used for display.

/** A penalty as the display needs it. */
export type DisplayPenalty = PenaltyLike & {
  race_number: number;
  driver_id: string | null;
  session_type: 'race' | 'qualifying' | 'practice';
};

/**
 * `${raceNumber}:${driverId}` -> that driver's effective time penalty (seconds) in that race. A
 * driver with any penalty in the race has an entry, even of 0 s; a qualifying or practice penalty
 * counts on race 1.
 */
export function timePenaltiesByRaceDriver(penalties: DisplayPenalty[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of penalties) {
    if (!p.driver_id) continue;
    const key = `${scoringRaceNumber(p)}:${p.driver_id}`;
    out.set(key, (out.get(key) ?? 0) + (effectiveTimePenaltySeconds(p) ?? 0));
  }
  return out;
}

/** One finisher, from curated_race_results. */
export interface GapInput {
  id: string;
  intervalTenThousandths: number | null;
  lapsComplete: number | null;
  averageLapTenThousandths: number | null;
}

/** The reference a race's laps down are counted from: the race leader (or, in the Per Class view, the class leader). */
export interface LeaderLap {
  lapsComplete: number | null;
  averageLapTenThousandths: number | null;
}

export interface DisplayGap {
  lapsDown: number;
  /** Ten-thousandths behind the leader once penalties are added; for laps-down rows only an estimate used to compare them. */
  gapTenThousandths: number | null;
}

/** The gap a row shows once its own time penalty is added (rules 18.3.1, 18.3.2). */
function penalisedGap(row: GapInput, penaltyT: number, leader: LeaderLap): DisplayGap {
  const lapsDownBefore =
    row.lapsComplete !== null && leader.lapsComplete !== null && leader.lapsComplete > row.lapsComplete
      ? leader.lapsComplete - row.lapsComplete
      : 0;
  const leaderAvg = leader.averageLapTenThousandths;
  if (lapsDownBefore === 0 && row.intervalTenThousandths !== null && row.intervalTenThousandths >= 0) {
    if (penaltyT === 0) return { lapsDown: 0, gapTenThousandths: row.intervalTenThousandths };
    const interval = row.intervalTenThousandths + penaltyT;
    if (leaderAvg !== null && leaderAvg > 0 && interval > leaderAvg) {
      const lapsDown = Math.floor(interval / leaderAvg);
      return { lapsDown, gapTenThousandths: interval - lapsDown * leaderAvg };
    }
    return { lapsDown: 0, gapTenThousandths: interval };
  }
  if (
    row.averageLapTenThousandths !== null &&
    row.lapsComplete !== null &&
    leaderAvg !== null &&
    leaderAvg > 0 &&
    leader.lapsComplete !== null
  ) {
    const gap = row.lapsComplete * row.averageLapTenThousandths - leader.lapsComplete * leaderAvg + penaltyT;
    return { lapsDown: Math.max(lapsDownBefore, Math.floor(gap / leaderAvg)), gapTenThousandths: gap };
  }
  return { lapsDown: lapsDownBefore, gapTenThousandths: null };
}

/**
 * Every row's laps down and gap in a race where penalties apply, keyed by row id. `penaltyTOf`
 * gives a row's time penalty in ten-thousandths. Lead-lap gaps are re-zeroed to the smallest one,
 * so the leader after penalties always reads 0.
 */
export function penalisedGaps(
  rows: GapInput[],
  penaltyTOf: (id: string) => number,
  leader: LeaderLap,
): Map<string, DisplayGap> {
  const out = new Map(rows.map((r) => [r.id, penalisedGap(r, penaltyTOf(r.id), leader)]));
  const leadLap = [...out.values()].filter((g) => g.lapsDown === 0 && g.gapTenThousandths !== null);
  if (leadLap.length > 0) {
    const zero = Math.min(...leadLap.map((g) => g.gapTenThousandths as number));
    for (const g of leadLap) g.gapTenThousandths = (g.gapTenThousandths as number) - zero;
  }
  return out;
}

/** The margin text for a penalised gap, or null when it has none of its own (the caller keeps the raw margin). */
export function penalisedMargin(gap: DisplayGap): string | null {
  if (gap.lapsDown > 0) return `-${gap.lapsDown}L`;
  if (gap.gapTenThousandths === null) return null;
  return gap.gapTenThousandths === 0 ? '—' : (gap.gapTenThousandths / 10000).toFixed(3);
}

/** The interval a penalised gap stands for, with iRacing's convention that a negative value means laps down. */
export function penalisedInterval(gap: DisplayGap): number | null {
  return gap.lapsDown > 0 ? -1 : gap.gapTenThousandths;
}

/** Overall race time: own laps × own average lap, plus the driver's own time penalty when it applies. */
export function overallRaceTimeTenThousandths(
  lapsComplete: number | null,
  averageLapTenThousandths: number | null,
  timePenaltySeconds: number | null,
): number | null {
  if (lapsComplete === null || averageLapTenThousandths === null) return null;
  return lapsComplete * averageLapTenThousandths + (timePenaltySeconds ?? 0) * 10000;
}

/** "41:07.512", or "—" when the race time is unknown. */
export function formatRaceTime(tenThousandths: number | null): string {
  return formatLapTime(tenThousandths === null ? null : tenThousandths / 10000);
}

/** The position to show struck through: the raw one, when the shown position differs from it. */
export function shownOldPosition(position: number | null, rawPosition: number | null): number | null {
  return position !== null && rawPosition !== null && position !== rawPosition ? rawPosition : null;
}

/**
 * Positions for entrants with no roster entry. The view scores them as part of the field but stores
 * no row for them, so the rostered rows' positions leave gaps where they finished. Each unrostered
 * entrant, in raw order, takes the next position no rostered row uses.
 */
export function fillUnrosteredPositions(rosteredPositions: number[], unrosteredCount: number): number[] {
  const used = new Set(rosteredPositions);
  const out: number[] = [];
  for (let p = 1; out.length < unrosteredCount; p++) if (!used.has(p)) out.push(p);
  return out;
}
