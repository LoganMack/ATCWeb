/**
 * Post-race penalties (rulebook 18.3, section 5 "Stewarding") — turning a
 * steward's decision into a recalculated race result, season standings, and
 * a driver's running season penalty-points (PP) tally.
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
 *     touches a driver's race/championship points, and vice versa. PP (and
 *     warning counts) are SEASON-scoped — see computeSeasonPPState below —
 *     while probation itself, once entered, runs on its own calendar clock
 *     independent of season boundaries (rule 61).
 *
 * APPEALS: a penalty can be marked `is_appealed`, with `appeal_result` (a
 * free-text ruling) and appeal_time_penalty_seconds/appeal_points_penalty/
 * appeal_penalty_points holding the corrected values the appeal landed on.
 * Every place this file reads a penalty's time/points/PP goes through the
 * effective* helpers below, which swap in the appeal_* values once
 * is_appealed is set — the original fields stay put as a record of what was
 * first logged, but stop being what's actually applied.
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

export type Format = 'endurance' | 'sprint';

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
// Appeals — effective-value helpers. Every consumer of a penalty's
// time/points/PP below goes through these instead of reading the raw
// columns directly, so an appeal transparently overrides what's applied.
// ---------------------------------------------------------------------------

export interface PenaltyLike {
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_appealed: boolean;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

/** The time penalty actually in effect — the appeal's corrected value once appealed, otherwise the original. */
export function effectiveTimePenaltySeconds(p: PenaltyLike): number | null {
  return p.is_appealed ? p.appeal_time_penalty_seconds : p.time_penalty_seconds;
}

/** The flat championship-points deduction actually in effect. */
export function effectivePointsPenalty(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_points_penalty : p.points_penalty;
}

/** The PP award actually in effect. */
export function effectivePenaltyPoints(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_penalty_points : p.penalty_points;
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

/** Sums every penalty logged against each (race_number, driver) pair in this round — a driver can accumulate more than one penalty for the same race, and their effects stack. Uses each penalty's effective (appeal-aware) time/points. */
export function sumPenaltiesByRaceDriver(
  penalties: (PenaltyLike & { race_number: number; driver_id: string })[]
): Map<string, RaceDriverPenaltyTotal> {
  const out = new Map<string, RaceDriverPenaltyTotal>();
  for (const p of penalties) {
    const key = `${p.race_number}:${p.driver_id}`;
    const cur = out.get(key) ?? { time: 0, points: 0 };
    cur.time += effectiveTimePenaltySeconds(p) ?? 0;
    cur.points += effectivePointsPenalty(p);
    out.set(key, cur);
  }
  return out;
}

/** Minimal shape reorderByTimePenalty needs — RaceResultRow and the season-standings row shapes both adapt to this. */
export interface Positionable {
  driverId: string;
  position: number | null;
  intervalTenThousandths: number | null;
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
  rows: Positionable[],
  raceNumber: number,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>
): Map<string, number> {
  const ranked = rows.filter((r) => r.position !== null);
  const withAdjusted = ranked.map((r) => {
    const timePenalty = penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`)?.time ?? 0;
    const onLeadLap = r.intervalTenThousandths !== null && r.intervalTenThousandths >= 0;
    const adjustedInterval = onLeadLap ? (r.intervalTenThousandths as number) + timePenalty * 10000 : null;
    return { driverId: r.driverId, onLeadLap, adjustedInterval, originalPosition: r.position as number };
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

// ---------------------------------------------------------------------------
// Shared points recompute — used by both the single-round engine
// (applyPenaltiesToRoundResults, below) and the season-wide one
// (applyPenaltiesToSeasonScores, in src/lib/results.ts's caller) so the two
// never drift apart on the actual point math.
// ---------------------------------------------------------------------------

interface ScoreLike {
  totalPoints: number;
  classPoints: number;
  finesseBonus: number;
  poleBonus: number;
  pointsDeduction: number;
  dsq: boolean;
  classified: boolean;
}

interface RecomputedScore {
  totalPoints: number;
  classPoints: number;
  pointsDeduction: number;
}

/**
 * Recomputes one (subsession, race, driver) row's points given its old and
 * new overall/class positions. Returns the row's ORIGINAL numbers untouched
 * when nothing about it actually changed (no penalty logged against this
 * driver in this race, AND neither position moved) — callers can use that
 * to cheaply skip writing anything back.
 */
function recomputeScorePoints(
  s: ScoreLike,
  driverId: string,
  raceNumber: number,
  newPosition: number | null,
  oldPosition: number | null,
  newClassPosition: number | null,
  oldClassPosition: number | null,
  format: Format | null,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>
): RecomputedScore {
  const pen = penaltyByRaceDriver.get(`${raceNumber}:${driverId}`);
  const positionChanged = newPosition !== oldPosition;
  const classPositionChanged = newClassPosition !== oldClassPosition;
  if (!pen && !positionChanged && !classPositionChanged) {
    return { totalPoints: s.totalPoints, classPoints: s.classPoints, pointsDeduction: s.pointsDeduction };
  }

  // Repositioning (and the points-table lookups that go with it) only makes
  // sense for a driver who's actually classified to begin with — DSQ'd/
  // unclassified rows keep their original points on that front, but a flat
  // points_penalty can still apply to them (rule 69: "drivers are allowed to
  // receive net negative points").
  const canReposition = !s.dsq && s.classified && format !== null;

  // Back out this row's ORIGINAL finish-points contribution from the
  // pipeline's own total, rather than re-deriving it from our own table —
  // that keeps an untouched (or class-only-affected) driver's finish points
  // byte-for-byte what the pipeline actually scored, only ever consulting
  // our own FINISH_POINTS table for a driver whose position genuinely moved.
  const originalFinishPoints = s.totalPoints - s.classPoints - s.finesseBonus - s.poleBonus - s.pointsDeduction;
  const finishPoints =
    canReposition && positionChanged && newPosition !== null
      ? finishPointsForPosition(format as Format, newPosition)
      : originalFinishPoints;

  // Same reasoning as finishPoints: only ever consult our own CLASS_POINTS
  // table for a driver whose class position actually moved — everyone else
  // keeps the pipeline's original class_points untouched.
  const classPoints =
    canReposition && classPositionChanged ? classPointsForPosition(format as Format, newClassPosition) : s.classPoints;

  const pointsDeduction = s.pointsDeduction - (pen?.points ?? 0);
  const totalPoints = finishPoints + classPoints + s.finesseBonus + s.poleBonus + pointsDeduction;

  return { totalPoints, classPoints, pointsDeduction };
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
  const canReposition = !row.dsq && classified && row.position !== null && format !== null;
  const effectivePosition = canReposition ? newPosition : row.position;

  const recomputed = recomputeScorePoints(
    {
      totalPoints: row.totalPoints,
      classPoints: row.classPoints,
      finesseBonus: row.finesseBonus,
      poleBonus: row.poleBonus,
      pointsDeduction: row.pointsDeduction,
      dsq: row.dsq,
      classified,
    },
    row.driver.id,
    raceNumber,
    newPosition,
    row.position,
    newClassPosition,
    originalClassPosition,
    format,
    penaltyByRaceDriver
  );

  return {
    ...row,
    position: effectivePosition,
    classPoints: recomputed.classPoints,
    pointsDeduction: recomputed.pointsDeduction,
    bonusPoints: recomputed.classPoints + row.finesseBonus + row.poleBonus + recomputed.pointsDeduction,
    totalPoints: recomputed.totalPoints,
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
export function applyPenaltiesToRoundResults(
  results: RoundResults,
  penalties: (PenaltyLike & { race_number: number; driver_id: string })[],
  format: Format | null
): RoundResults {
  if (penalties.length === 0) return results;
  const penaltyByRaceDriver = sumPenaltiesByRaceDriver(penalties);

  const raceNumbers = new Set<number>([
    ...results.overall.keys(),
    ...[...results.byClass.values()].flatMap((byRace) => [...byRace.keys()]),
  ]);

  const newOverall = new Map(results.overall);
  const newByClass = new Map([...results.byClass].map(([classId, byRace]) => [classId, new Map(byRace)] as const));

  const toPositionable = (rows: RaceResultRow[]): Positionable[] =>
    rows.map((r) => ({ driverId: r.driver.id, position: r.position, intervalTenThousandths: r.intervalTenThousandths }));

  for (const raceNumber of raceNumbers) {
    const overallRows = results.overall.get(raceNumber);
    if (!overallRows) continue;
    const touchedThisRace = overallRows.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driver.id}`));
    if (!touchedThisRace) continue;

    const newOverallPositions = reorderByTimePenalty(toPositionable(overallRows), raceNumber, penaltyByRaceDriver);

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
      const newPositions = reorderByTimePenalty(toPositionable(classRows), raceNumber, penaltyByRaceDriver);
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
// Season-wide points recompute — same engine as applyPenaltiesToRoundResults
// above, batched across every round in a season at once (used by
// computeSeasonStandings/computeOverallSeasonStandings in src/lib/results.ts)
// rather than called once per round, which would mean an unacceptable
// number of extra requests on pages that show many seasons at once (e.g.
// Champions). Only touched (subsessionId, raceNumber, driverId) triples are
// returned — everything else should keep using its original race_scores
// value.
// ---------------------------------------------------------------------------

export interface SeasonScoreRow {
  subsessionId: number;
  raceNumber: number;
  driverId: string;
  dsq: boolean;
  classified: boolean;
  /** Overall (cross-class) field position for this race — race_scores.scored_position. */
  scoredPosition: number | null;
  intervalTenThousandths: number | null;
  finishPoints: number;
  finesseBonus: number;
  poleBonus: number;
  pointsDeduction: number;
}

export interface SeasonOverallAdjustment {
  newPosition: number | null;
  finishPoints: number;
  pointsDeduction: number;
  /** finishPoints + finesseBonus + poleBonus + pointsDeduction — deliberately excluding class_points, matching computeOverallSeasonStandings' own points formula. */
  overallTotalPoints: number;
}

/**
 * Cross-class pass: re-ranks every driver in every touched race by overall
 * field position (adding time penalties to their gap-to-leader, same as the
 * results page) and recomputes finishPoints/pointsDeduction from that.
 * Powers computeOverallSeasonStandings directly, and also supplies the
 * "what's this driver's overall position/finishPoints now" lookup that
 * computeSeasonStandings (per class) layers its own class-relative
 * class_points recompute on top of — finishPoints is always based on
 * overall position, never class position, so a per-class computation can't
 * derive it from its own (class-filtered) rows alone.
 */
export function computeSeasonOverallAdjustments(
  rows: SeasonScoreRow[],
  penalties: (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string })[],
  formatBySubsession: Map<number, Format | null>
): Map<string, SeasonOverallAdjustment> {
  const out = new Map<string, SeasonOverallAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) => `${subsessionId}:${raceNumber}:${driverId}`;

  const penaltiesByRace = new Map<string, (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string })[]>();
  for (const p of penalties) {
    const key = raceKey(p.subsession_id, p.race_number);
    if (!penaltiesByRace.has(key)) penaltiesByRace.set(key, []);
    penaltiesByRace.get(key)!.push(p);
  }

  const byRace = new Map<string, SeasonScoreRow[]>();
  for (const r of rows) {
    const key = raceKey(r.subsessionId, r.raceNumber);
    if (!byRace.has(key)) byRace.set(key, []);
    byRace.get(key)!.push(r);
  }

  for (const [key, group] of byRace) {
    const racePenalties = penaltiesByRace.get(key);
    if (!racePenalties || racePenalties.length === 0) continue;

    const raceNumber = group[0].raceNumber;
    const subsessionId = group[0].subsessionId;
    const format = formatBySubsession.get(subsessionId) ?? null;
    // reorderByTimePenalty's map key is scoped by raceNumber alone — safe
    // here because we only ever hand it this one race's own group/penalties.
    const penaltyByRaceDriver = sumPenaltiesByRaceDriver(
      racePenalties.map((p) => ({ ...p, race_number: raceNumber }))
    );
    // Only actually reorder this group if one of ITS OWN drivers has a
    // penalty — `racePenalties` can be nonempty just because some OTHER
    // class's driver was penalized in this same race. Reordering by interval
    // even with an all-zero penalty map isn't guaranteed byte-identical to
    // the original raw-position sort (ties/pipeline quirks), so skipping
    // untouched groups entirely avoids spurious position/point changes.
    const touched = group.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driverId}`));
    if (!touched) continue;

    const positionable: Positionable[] = group
      .filter((r) => !r.dsq && r.scoredPosition !== null)
      .map((r) => ({ driverId: r.driverId, position: r.scoredPosition, intervalTenThousandths: r.intervalTenThousandths }));
    const newPositions = reorderByTimePenalty(positionable, raceNumber, penaltyByRaceDriver);

    for (const r of group) {
      const pen = penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`);
      const newPosition = newPositions.get(r.driverId) ?? r.scoredPosition;
      const positionChanged = newPosition !== r.scoredPosition;
      if (!pen && !positionChanged) continue;

      const canReposition = !r.dsq && r.classified && format !== null;
      const finishPoints =
        canReposition && positionChanged && newPosition !== null
          ? finishPointsForPosition(format as Format, newPosition)
          : r.finishPoints;
      const pointsDeduction = r.pointsDeduction - (pen?.points ?? 0);
      const overallTotalPoints = finishPoints + r.finesseBonus + r.poleBonus + pointsDeduction;

      out.set(rowKey(r.subsessionId, r.raceNumber, r.driverId), {
        newPosition: canReposition ? newPosition : r.scoredPosition,
        finishPoints,
        pointsDeduction,
        overallTotalPoints,
      });
    }
  }

  return out;
}

export interface SeasonClassScoreRow {
  subsessionId: number;
  raceNumber: number;
  driverId: string;
  dsq: boolean;
  classified: boolean;
  /** This driver's class-relative rank in this race, before any penalty (re-derived from curated_race_results the same way computeSeasonStandings' existing ranking pass does). */
  classPosition: number | null;
  intervalTenThousandths: number | null;
  totalPoints: number;
  classPoints: number;
  finesseBonus: number;
  poleBonus: number;
  pointsDeduction: number;
}

export interface SeasonClassAdjustment {
  newClassPosition: number | null;
  totalPoints: number;
}

/**
 * Per-class pass: re-ranks one class's rows within each touched race
 * (class-relative, same cascade rule as everything else) and recomputes
 * each driver's full totalPoints (finish + class + finesse + pole +
 * deduction) — pulling the finishPoints/pointsDeduction components from the
 * shared overall adjustment (see computeSeasonOverallAdjustments) rather
 * than re-deriving them, so the two views can never disagree on a shared
 * number. Powers computeSeasonStandings' per-race win/podium/top5/top10
 * tallying and its point totals.
 */
export function computeSeasonClassAdjustments(
  rows: SeasonClassScoreRow[],
  penalties: (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string })[],
  formatBySubsession: Map<number, Format | null>,
  overallAdjustments: Map<string, SeasonOverallAdjustment>
): Map<string, SeasonClassAdjustment> {
  const out = new Map<string, SeasonClassAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) => `${subsessionId}:${raceNumber}:${driverId}`;

  const penaltiesByRace = new Map<string, (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string })[]>();
  for (const p of penalties) {
    const key = raceKey(p.subsession_id, p.race_number);
    if (!penaltiesByRace.has(key)) penaltiesByRace.set(key, []);
    penaltiesByRace.get(key)!.push(p);
  }

  const byRace = new Map<string, SeasonClassScoreRow[]>();
  for (const r of rows) {
    const key = raceKey(r.subsessionId, r.raceNumber);
    if (!byRace.has(key)) byRace.set(key, []);
    byRace.get(key)!.push(r);
  }

  for (const [key, group] of byRace) {
    const racePenalties = penaltiesByRace.get(key);
    if (!racePenalties || racePenalties.length === 0) continue;

    const raceNumber = group[0].raceNumber;
    const subsessionId = group[0].subsessionId;
    const format = formatBySubsession.get(subsessionId) ?? null;
    const penaltyByRaceDriver = sumPenaltiesByRaceDriver(
      racePenalties.map((p) => ({ ...p, race_number: raceNumber }))
    );
    // Same reasoning as computeSeasonOverallAdjustments: only reorder this
    // class's group if one of ITS OWN drivers was actually penalized.
    const touched = group.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driverId}`));
    if (!touched) continue;

    const positionable: Positionable[] = group
      .filter((r) => !r.dsq && r.classPosition !== null)
      .map((r) => ({ driverId: r.driverId, position: r.classPosition, intervalTenThousandths: r.intervalTenThousandths }));
    const newClassPositions = reorderByTimePenalty(positionable, raceNumber, penaltyByRaceDriver);

    for (const r of group) {
      const pen = penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`);
      const newClassPosition = newClassPositions.get(r.driverId) ?? r.classPosition;
      const classPositionChanged = newClassPosition !== r.classPosition;
      if (!pen && !classPositionChanged) continue;

      const canReposition = !r.dsq && r.classified && format !== null;
      const overall = overallAdjustments.get(rowKey(r.subsessionId, r.raceNumber, r.driverId));
      const finishPoints = overall ? overall.finishPoints : r.totalPoints - r.classPoints - r.finesseBonus - r.poleBonus - r.pointsDeduction;
      const pointsDeduction = overall ? overall.pointsDeduction : r.pointsDeduction - (pen?.points ?? 0);
      const classPoints =
        canReposition && classPositionChanged ? classPointsForPosition(format as Format, newClassPosition) : r.classPoints;
      const totalPoints = finishPoints + classPoints + r.finesseBonus + r.poleBonus + pointsDeduction;

      out.set(rowKey(r.subsessionId, r.raceNumber, r.driverId), {
        newClassPosition: canReposition ? newClassPosition : r.classPosition,
        totalPoints,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Penalty points (PP), warnings & probation — rules 57-62
// ---------------------------------------------------------------------------

export interface DriverPPState {
  penalty_points: number;
  penalty_points_max: number;
  on_probation: boolean;
  probation_started_at: string | null;
}

/**
 * Whether a driver's probation is still in effect as of `today` (defaults
 * to right now). Rule 61: "Probation lasts for either 4 rounds or 45 days,
 * whichever is longer" — confirmed with Logan that "4 rounds" means every
 * scheduled calendar round, not just ones this driver actually starts, so
 * this counts events rather than race_scores appearances. Both conditions
 * must clear (45 days elapsed AND 4 qualifying rounds have passed) for
 * probation to end, which is exactly equivalent to "whichever threshold is
 * later" — see this function's own logic for why.
 *
 * Probation itself runs on this independent calendar clock regardless of
 * season boundaries — only the PP tally that triggers it (see
 * computeSeasonPPState) is season-scoped.
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
 * Applies one penalty's PP award to a driver's running tally, doubling it
 * first if they're currently mid-probation (rule 60), and triggers the
 * hard-reset-to-0 + enter/renew-probation behavior once the total reaches
 * the limit (confirmed with Logan: any amount over the limit is simply
 * discarded, not carried over).
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

export interface SeasonPPState {
  penalty_points: number;
  on_probation: boolean;
  probation_started_at: string | null;
}

/**
 * Recomputes a driver's PP TALLY from scratch by replaying every penalty
 * logged against them THIS SEASON, in the order they were entered — rather
 * than incrementally mutating a stored counter on each new penalty (the
 * v0.13/v0.14 approach). Replaying means:
 *   - PP is season-scoped (confirmed with Logan: "penalty points... should
 *     be season-scoped, not career-scoped") — a penalty from a previous
 *     season simply isn't in `penalties`' input list, so it can't
 *     contribute here, however long ago the tally was last touched.
 *   - Editing or deleting a penalty now correctly ripples through: since
 *     this always starts the TALLY from 0 and replays the current set of
 *     season penalties, there's no separate "undo" step needed — the
 *     caller just re-runs this and persists the result after any mutation.
 *   - Doubling-during-probation (rule 60) still applies correctly even
 *     retroactively, since each step checks whether probation was active
 *     AS OF that specific penalty's own created_at.
 *
 * Probation itself is NOT reset to this function's season scope — it's
 * seeded from `driver`'s ACTUAL on_probation/probation_started_at (rule 61:
 * once triggered, probation runs its own 45-day/4-round calendar clock
 * independent of season boundaries, so a driver whose probation was
 * triggered by a penalty from a PREVIOUS season and is still active today
 * must stay on probation here — replaying only this season's penalties
 * must never silently clear that). If none of this season's penalties push
 * the tally to a fresh limit-hit, the returned on_probation/
 * probation_started_at simply pass the seed straight through unchanged.
 *
 * `penalties` should be pre-filtered to this driver and the current season
 * by the caller (see getPenaltiesForSubsessions + getCurrentSeasonRounds in
 * src/lib/supabase.ts / src/lib/results.ts) — this function doesn't do that
 * filtering itself.
 */
export function computeSeasonPPState(
  driver: { penalty_points_max: number; on_probation: boolean; probation_started_at: string | null },
  penalties: (PenaltyLike & { created_at: string })[],
  events: { event_date: string }[]
): SeasonPPState {
  let state: DriverPPState = {
    penalty_points: 0,
    penalty_points_max: driver.penalty_points_max,
    on_probation: driver.on_probation,
    probation_started_at: driver.probation_started_at,
  };

  const sorted = [...penalties].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const p of sorted) {
    const awarded = effectivePenaltyPoints(p);
    if (awarded <= 0) continue;
    const asOf = new Date(p.created_at);
    const wasOnProbation = isOnProbationNow(state, events, asOf);
    state = applyPenaltyPointsToDriver(state, awarded, wasOnProbation, asOf).state;
  }

  return { penalty_points: state.penalty_points, on_probation: state.on_probation, probation_started_at: state.probation_started_at };
}

/** Counts is_warning penalties from an already season-filtered list — see getPenaltiesForSeason. Kept as a tiny function (rather than inlining) so both the per-driver dialog note and any future season-wide tally read it the same way. */
export function countWarnings(penalties: { is_warning: boolean }[]): number {
  return penalties.filter((p) => p.is_warning).length;
}
