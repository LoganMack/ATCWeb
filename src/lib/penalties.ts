/**
 * Post-race penalties (rulebook 18.3, section 5 "Stewarding") — turning a
 * steward's decision into a recalculated race result and a driver's running
 * season penalty-points (PP) tally.
 *
 * Two genuinely separate systems share the word "points" here, and it's
 * worth keeping them straight:
 *   - Championship/race points (finish_points, class_points, etc. — what
 *     the standings pages total up) — a penalty can flatly deduct from
 *     these (`points_penalty` on a Penalty row) and/or indirectly change
 *     them by moving the driver's finishing position (`time_penalty_seconds`).
 *   - Penalty points (PP) — a season-long behavioral tally, capped at
 *     `drivers.penalty_points_max` (11 per the rulebook), that drives bans
 *     and probation. Entirely separate from race points; a PP award never
 *     touches a driver's race/championship points, and vice versa.
 *
 * DOCUMENTED SIMPLIFICATIONS (deliberately out of scope for this pass):
 *   - Rule 58 (DSQ instead of reset if the PP limit is hit in the season's
 *     final round) and rule 62 (10-round ban for hitting the limit again
 *     while already on probation) aren't automated — both describe
 *     real-world consequences (sitting a driver out, DSQing a round) that
 *     this app doesn't have anywhere to track or enforce. The admin UI
 *     surfaces a note when either applies so the stewards handle it
 *     manually.
 *   - Rule 64's "a large enough time penalty pushes a driver a full lap
 *     down" conversion isn't modeled — this file re-sorts a time-penalized
 *     driver only within their existing lead-lap-or-laps-down group (see
 *     reorderByTimePenalty below), since the app doesn't have per-driver
 *     lap-time data to convert seconds into laps. A penalty large enough to
 *     plausibly cross that boundary should be double-checked manually.
 */

import type { RaceResultRow, RoundResults } from './results';

// ---------------------------------------------------------------------------
// Points tables — Table: Points System, Table: Class Points (rulebook 18.3)
// ---------------------------------------------------------------------------

type Format = 'endurance' | 'sprint';

/** Index 0 = position 1. Position 40 is the last explicit row; anyone classified beyond it gets CLASSIFIED_FALLBACK_POINTS instead (rule 31: "drivers who finish outside the points but above the >50% threshold earn minimum points"). */
const FINISH_POINTS: Record<Format, number[]> = {
  endurance: [
    200, 190, 180, 170, 162, 154, 146, 138, 130, 122, 114, 108, 102, 96, 90, 84, 78, 72, 66, 60, 54, 50, 46, 42, 38,
    34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6,
  ],
  sprint: [
    100, 95, 90, 85, 81, 77, 73, 69, 65, 61, 57, 54, 51, 48, 45, 42, 39, 36, 33, 30, 27, 25, 23, 21, 19, 17, 16, 15,
    14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
  ],
};

const CLASSIFIED_FALLBACK_POINTS: Record<Format, number> = { endurance: 6, sprint: 3 };

/** Index 0 = 1st in class. No 4th-in-class-or-worse bonus exists. */
const CLASS_POINTS: Record<Format, number[]> = {
  endurance: [8, 4, 2],
  sprint: [4, 2, 1],
};

/** A classified driver's base finishing points for a given overall position — the main Points System table, not the +/- class-position bonus (see classPointsForPosition). */
export function finishPointsForPosition(format: Format, position: number): number {
  if (position >= 1 && position <= FINISH_POINTS[format].length) return FINISH_POINTS[format][position - 1];
  return CLASSIFIED_FALLBACK_POINTS[format];
}

/** The Class Points top-3-in-class bonus (0 outside the top 3). */
export function classPointsForPosition(format: Format, classPosition: number | null): number {
  if (classPosition === null || classPosition < 1 || classPosition > CLASS_POINTS[format].length) return 0;
  return CLASS_POINTS[format][classPosition - 1];
}

// ---------------------------------------------------------------------------
// Position recalculation — rule 64: "it is added to their total race time
// ... the driver is then classified on that lap and ranked by its total
// race time." We don't have literal total race time, but `intervalTenThousandths`
// (gap to the leader) is an equivalent proxy for anyone still on the lead
// lap — adding the penalty to it and re-sorting reproduces the same order a
// real re-classification would.
// ---------------------------------------------------------------------------

interface RaceDriverPenaltyTotal {
  time: number; // seconds
  points: number; // flat championship-points deduction
}

/** Sums every penalty logged against each (race_number, driver) pair in this round — a driver can accumulate more than one penalty for the same race, and their effects stack. */
export function sumPenaltiesByRaceDriver(penalties: { race_number: number; driver_id: string; time_penalty_seconds: number | null; points_penalty: number }[]): Map<string, RaceDriverPenaltyTotal> {
  const out = new Map<string, RaceDriverPenaltyTotal>();
  for (const p of penalties) {
    const key = `${p.race_number}:${p.driver_id}`;
    const cur = out.get(key) ?? { time: 0, points: 0 };
    cur.time += p.time_penalty_seconds ?? 0;
    cur.points += p.points_penalty ?? 0;
    out.set(key, cur);
  }
  return out;
}

/**
 * Re-ranks one race's rows (either the overall field or one class's slice
 * of it) after adding each penalized driver's time penalty to their gap to
 * the leader. Only reorders within the same "lap status" group — lead-lap
 * drivers (interval >= 0) against each other, laps-down drivers (interval <
 * 0, iRacing's "-xL" flag — not a real time value, see CuratedRaceResultRow
 * in results.ts) keep their existing relative order among themselves, since
 * a penalty in seconds can't be meaningfully compared against that flag.
 * Rows without a position (DSQ'd/unranked) are left out entirely.
 */
export function reorderByTimePenalty(
  rows: RaceResultRow[],
  raceNumber: number,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>
): Map<string, number> {
  const ranked = rows.filter((r) => r.position !== null);
  const withAdjusted = ranked.map((r) => {
    const timePenalty = penaltyByRaceDriver.get(`${raceNumber}:${r.driver.id}`)?.time ?? 0;
    const onLeadLap = r.intervalTenThousandths !== null && r.intervalTenThousandths >= 0;
    const adjustedInterval = onLeadLap ? (r.intervalTenThousandths as number) + timePenalty * 10000 : null;
    return { driverId: r.driver.id, onLeadLap, adjustedInterval, originalPosition: r.position as number };
  });

  withAdjusted.sort((a, b) => {
    if (a.onLeadLap !== b.onLeadLap) return a.onLeadLap ? -1 : 1;
    if (a.onLeadLap) {
      const av = a.adjustedInterval ?? Infinity;
      const bv = b.adjustedInterval ?? Infinity;
      if (av !== bv) return av - bv;
    }
    return a.originalPosition - b.originalPosition;
  });

  const out = new Map<string, number>();
  withAdjusted.forEach((entry, i) => out.set(entry.driverId, i + 1));
  return out;
}

function recomputeRow(
  row: RaceResultRow,
  newPosition: number | null,
  newClassPosition: number | null,
  originalClassPosition: number | null,
  raceNumber: number,
  format: Format | null,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>
): RaceResultRow {
  const pen = penaltyByRaceDriver.get(`${raceNumber}:${row.driver.id}`);
  const positionChanged = newPosition !== row.position;
  const classPositionChanged = newClassPosition !== originalClassPosition;
  if (!pen && !positionChanged && !classPositionChanged) return row;

  const classified = !row.tags.includes('Unclassified');
  // Repositioning (and the points-table lookups that go with it) only makes
  // sense for a driver who's actually classified and ranked to begin with —
  // DSQ'd/unclassified rows keep whatever position they already had (null,
  // in practice), but a flat points_penalty can still apply to them (rule
  // 69: "drivers are allowed to receive net negative points").
  const canReposition = !row.dsq && classified && row.position !== null && format !== null;

  const effectivePosition = canReposition ? newPosition : row.position;
  const effectiveClassPosition = canReposition ? newClassPosition : null;

  // Back out this row's ORIGINAL finish-points contribution from the
  // pipeline's own total, rather than re-deriving it from our own table —
  // that keeps an untouched (or class-only-affected) driver's finish points
  // byte-for-byte what the pipeline actually scored, only ever consulting
  // our own FINISH_POINTS table for a driver whose position genuinely moved
  // (the one case where we have no choice — the pipeline never scored that
  // position for them).
  const originalFinishPoints = row.totalPoints - row.classPoints - row.finesseBonus - row.poleBonus - row.pointsDeduction;
  const finishPoints =
    canReposition && positionChanged && effectivePosition !== null && format !== null
      ? finishPointsForPosition(format, effectivePosition)
      : originalFinishPoints;

  // Same reasoning as finishPoints above: only ever consult our own
  // CLASS_POINTS table for a driver whose class position actually moved
  // (their own penalty, or a cascade from another driver's) — everyone
  // else keeps the pipeline's original class_points untouched, even though
  // this race had some penalty logged somewhere in it.
  const classPoints =
    canReposition && classPositionChanged && format !== null
      ? classPointsForPosition(format, effectiveClassPosition)
      : row.classPoints;

  const pointsDeduction = row.pointsDeduction - (pen?.points ?? 0);
  const bonusPoints = classPoints + row.finesseBonus + row.poleBonus + pointsDeduction;
  const totalPoints = finishPoints + bonusPoints;

  return {
    ...row,
    position: effectivePosition,
    classPoints,
    pointsDeduction,
    bonusPoints,
    totalPoints,
    wasAdjusted: row.wasAdjusted || (canReposition && positionChanged),
    penaltyOldPosition: canReposition && positionChanged ? row.position : row.penaltyOldPosition,
    hasPenalty: row.hasPenalty || Boolean(pen),
  };
}

/**
 * The main entry point: given a round's results (as produced by
 * getRoundResults()) and every penalty logged for that round, returns a new
 * RoundResults with positions/points recalculated everywhere a penalty
 * (directly, or by cascading past other drivers — confirmed with Logan:
 * time penalties fully re-sort the field, not just annotate the penalized
 * driver) changed the outcome. Races with no penalties are returned
 * untouched (same object identity) so callers can cheaply tell nothing
 * changed.
 */
export function applyPenaltiesToRoundResults(results: RoundResults, penalties: { race_number: number; driver_id: string; time_penalty_seconds: number | null; points_penalty: number }[], format: Format | null): RoundResults {
  if (penalties.length === 0) return results;
  const penaltyByRaceDriver = sumPenaltiesByRaceDriver(penalties);

  const raceNumbers = new Set<number>([
    ...results.overall.keys(),
    ...[...results.byClass.values()].flatMap((byRace) => [...byRace.keys()]),
  ]);

  const newOverall = new Map(results.overall);
  const newByClass = new Map([...results.byClass].map(([classId, byRace]) => [classId, new Map(byRace)] as const));

  for (const raceNumber of raceNumbers) {
    const overallRows = results.overall.get(raceNumber);
    if (!overallRows) continue;
    const touchedThisRace = overallRows.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driver.id}`));
    if (!touchedThisRace) continue;

    const newOverallPositions = reorderByTimePenalty(overallRows, raceNumber, penaltyByRaceDriver);

    // Pass 1: recompute every class's new position order for this race, and
    // build one driver -> new-class-position lookup — the OVERALL view's
    // points recompute needs each driver's class position too (both views
    // share one underlying points total, they just group the same rows
    // differently), so this has to be gathered across all classes before
    // either view is actually written back.
    const positionsByClassId = new Map<number, Map<string, number>>();
    const newClassPositionByDriver = new Map<string, number>();
    const originalClassPositionByDriver = new Map<string, number>();
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = reorderByTimePenalty(classRows, raceNumber, penaltyByRaceDriver);
      positionsByClassId.set(classId, newPositions);
      for (const [driverId, pos] of newPositions) newClassPositionByDriver.set(driverId, pos);
      // `results` (as opposed to newByClass) still holds each row exactly
      // as getRoundResults() produced it — its own `position` field IS that
      // driver's original class position, for a class-view row.
      for (const row of classRows) if (row.position !== null) originalClassPositionByDriver.set(row.driver.id, row.position);
    }

    // Pass 2: write back recomputed rows for both views.
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = positionsByClassId.get(classId)!;
      newByClass.get(classId)!.set(
        raceNumber,
        classRows.map((row) =>
          recomputeRow(
            row,
            newPositions.get(row.driver.id) ?? row.position,
            newClassPositionByDriver.get(row.driver.id) ?? null,
            originalClassPositionByDriver.get(row.driver.id) ?? null,
            raceNumber,
            format,
            penaltyByRaceDriver
          )
        )
      );
    }

    newOverall.set(
      raceNumber,
      overallRows.map((row) =>
        recomputeRow(
          row,
          newOverallPositions.get(row.driver.id) ?? row.position,
          newClassPositionByDriver.get(row.driver.id) ?? null,
          originalClassPositionByDriver.get(row.driver.id) ?? null,
          raceNumber,
          format,
          penaltyByRaceDriver
        )
      )
    );
  }

  return { byClass: newByClass, overall: newOverall };
}

// ---------------------------------------------------------------------------
// Penalty points (PP) & probation — rules 57-62
// ---------------------------------------------------------------------------

export interface DriverPPState {
  penalty_points: number;
  penalty_points_max: number;
  on_probation: boolean;
  probation_started_at: string | null;
}

/**
 * Whether a driver's probation is still in effect right now. Rule 61:
 * "Probation lasts for either 4 rounds or 45 days, whichever is longer" —
 * confirmed with Logan that "4 rounds" means every scheduled calendar
 * round, not just ones this driver actually starts, so this counts events
 * rather than race_scores appearances. Both conditions must clear (45 days
 * elapsed AND 4 qualifying rounds have passed) for probation to end, which
 * is exactly equivalent to "whichever threshold is later" — see this
 * function's own logic for why.
 */
export function isOnProbationNow(
  driver: { on_probation: boolean; probation_started_at: string | null },
  events: { event_date: string }[],
  today: Date = new Date()
): boolean {
  if (!driver.on_probation || !driver.probation_started_at) return false;
  const start = new Date(`${driver.probation_started_at}T00:00:00`);
  const daysElapsed = (today.getTime() - start.getTime()) / 86_400_000;
  if (daysElapsed < 45) return true;

  const todayStr = today.toISOString().slice(0, 10);
  const roundsElapsed = events.filter((e) => e.event_date > driver.probation_started_at! && e.event_date <= todayStr).length;
  return roundsElapsed < 4;
}

export interface ApplyPPResult {
  state: DriverPPState;
  /** True when this award pushed the driver's total to/past the limit and triggered a reset + (re-)entry into probation — surfaced so the caller can show a steward-facing reminder about rules 58/62 (see this file's header). */
  hitLimit: boolean;
  /** True when hitLimit is true AND the driver was already on probation when it happened — rule 62's 10-round-ban trigger, not automated (see header). */
  repeatDuringProbation: boolean;
}

/**
 * Applies one penalty's PP award to a driver's running season tally,
 * doubling it first if they're currently mid-probation (rule 60), and
 * triggers the hard-reset-to-0 + enter/renew-probation behavior once the
 * total reaches the limit (confirmed with Logan: any amount over the limit
 * is simply discarded, not carried over).
 */
export function applyPenaltyPointsToDriver(
  driver: DriverPPState,
  awardedPoints: number,
  isCurrentlyOnProbation: boolean,
  today: Date = new Date()
): ApplyPPResult {
  if (awardedPoints <= 0) return { state: driver, hitLimit: false, repeatDuringProbation: false };

  const earned = isCurrentlyOnProbation ? awardedPoints * 2 : awardedPoints;
  const newTotal = driver.penalty_points + earned;

  if (newTotal >= driver.penalty_points_max) {
    return {
      state: {
        ...driver,
        penalty_points: 0,
        on_probation: true,
        probation_started_at: today.toISOString().slice(0, 10),
      },
      hitLimit: true,
      repeatDuringProbation: isCurrentlyOnProbation,
    };
  }

  return { state: { ...driver, penalty_points: newTotal }, hitLimit: false, repeatDuringProbation: false };
}
