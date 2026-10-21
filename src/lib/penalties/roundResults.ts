import type { RaceResultRow, RoundResults } from '../results';
import { formatLapTime } from '../supabase';
import type { PenaltyLike } from './effective';
import {
  classPointsFromTables,
  finishPointsFromTables,
  resolvePointsTables,
  type Format,
  type RacePointsTables,
} from './points';
import {
  reorderByTimePenalty,
  sumPenaltiesByRaceDriver,
  type LeaderRaceStats,
  type Positionable,
  type RaceDriverPenaltyTotal,
  type RankedPosition,
} from './reorder';

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
  /** Like finesseBonus/poleBonus — a penalty never touches this (recalculate_race_scores() computes it off the officially-adjusted position, upstream of any of this file's own display-time recompute), so it only ever needs to be read here, never written. */
  aggressionBonus: number;
  /** Like aggressionBonus above — untouched by any penalty, only ever read here (0067_ruleset_overhaul_and_bonuses.sql). */
  lapLedBonus: number;
  fewestIncidentsBonus: number;
  fastestLapBonus: number;
  sprintSweepBonus: number;
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
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>,
  /** Whether this driver's class awards the top-3-in-class Class Points bonus at all — false for Alpha, see classPointsForPosition. */
  awardsClassPoints: boolean,
  /** This race's actual points tables (see resolvePointsTables) — pricing a repositioned driver's new finish/class points off these instead of the fixed FINISH_POINTS/CLASS_POINTS tables whenever the season's ruleset resolves one. */
  pointsTables: RacePointsTables,
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
  const originalFinishPoints =
    s.totalPoints -
    s.classPoints -
    s.finesseBonus -
    s.poleBonus -
    s.aggressionBonus -
    s.lapLedBonus -
    s.fewestIncidentsBonus -
    s.fastestLapBonus -
    s.sprintSweepBonus -
    s.pointsDeduction;
  const finishPoints =
    canReposition && positionChanged && newPosition !== null
      ? finishPointsFromTables(format as Format, newPosition, pointsTables)
      : originalFinishPoints;

  // Same reasoning as finishPoints: only ever consult the points table for a
  // driver whose class position actually moved — everyone else keeps the
  // pipeline's original class_points untouched. Gated on awardsClassPoints
  // too, so a podium shuffle in a class that never earns this bonus (Alpha)
  // can never manufacture nonzero class points the original pipeline data
  // would never have had.
  const classPoints =
    canReposition && classPositionChanged
      ? classPointsFromTables(format as Format, newClassPosition, awardsClassPoints, pointsTables)
      : s.classPoints;

  const pointsDeduction = s.pointsDeduction - (pen?.points ?? 0);
  const totalPoints =
    finishPoints +
    classPoints +
    s.finesseBonus +
    s.poleBonus +
    s.aggressionBonus +
    s.lapLedBonus +
    s.fewestIncidentsBonus +
    s.fastestLapBonus +
    s.sprintSweepBonus +
    pointsDeduction;

  return { totalPoints, classPoints, pointsDeduction };
}

function recomputeRow(
  row: RaceResultRow,
  newPosition: number | null,
  newClassPosition: number | null,
  originalClassPosition: number | null,
  raceNumber: number,
  format: Format | null,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>,
  /**
   * The reordering result to refresh margin/tags display FROM, for EVERY
   * row in a touched race — not just ones with their own penalty, since the
   * leader a margin is measured against can itself change. For the Overall
   * view this is always the OVERALL reorder (measured against the race's
   * actual on-track leader, per rule 18.3.2 — see this file's Position
   * recalculation header). For the Per Class view (byClass rows) this is
   * instead a class-scoped reorder measured against that class's own
   * leader, so margin reads "distance to the class leader" there — position/
   * laps-down/DSQ handling stays rules-correct either way since THAT still
   * always comes from the overall-leader-based reorder (newPosition/
   * newClassPosition, passed separately above); only the display-only
   * margin/tags/intervalTenThousandths below are sourced from this
   * class-scoped reorder instead. Undefined when the race wasn't reordered
   * at all.
   */
  overallRanked: RankedPosition | undefined,
  /** classId -> whether that class awards the top-3-in-class Class Points bonus at all (false for Alpha) — looked up via row.classId, which is always this row's own class whether it came from the byClass loop or the overall loop. */
  classPointsEligibleByClassId: Map<number, boolean>,
  /** This race's actual points tables (see resolvePointsTables) — same for every row in this race regardless of class. */
  pointsTables: RacePointsTables,
): RaceResultRow {
  const awardsClassPoints = classPointsEligibleByClassId.get(row.classId) ?? true;
  const pen = penaltyByRaceDriver.get(`${raceNumber}:${row.driver.id}`);
  const positionChanged = newPosition !== row.position;
  const classPositionChanged = newClassPosition !== originalClassPosition;

  // Margin/tags are always measured against the CURRENT leader of whichever
  // reorder `overallRanked` was built from — the race's overall leader for
  // an Overall-view row, or that row's own class leader for a byClass row
  // (see applyPenaltiesToRoundResults' two separate reorder passes)
  // (reorderByTimePenalty re-zeroes the lead-lap group against whoever
  // actually has the smallest total time now — see its own comments), so
  // ANY row's margin can change even if that row itself was never
  // penalized and never moved position: if the relevant leader picked up a
  // penalty small enough to keep the win, their own margin drops to 0 and
  // everyone else's shifts by exactly the leader's penalty, all without
  // anyone's relative ORDER (or points) changing at all. So this can't be
  // gated on `pen` or a position change the way points/position below are.
  let margin = row.margin;
  let intervalTenThousandths = row.intervalTenThousandths;
  const tags = row.tags;
  if (overallRanked) {
    if (overallRanked.lapsDown > 0) {
      margin = `-${overallRanked.lapsDown}L`;
      intervalTenThousandths = -1; // matches CuratedRaceResultRow's own "negative = laps down" convention
    } else if (overallRanked.gapTenThousandths !== null) {
      // Still on the lead lap post-penalty, so this is always >= 0 — same
      // formatting results.ts's formatMargin() uses for a non-negative,
      // nonzero interval (kept inline here rather than importing that
      // function, to avoid a runtime value-level import cycle between this
      // file and results.ts — the two already share type-only imports).
      margin =
        overallRanked.gapTenThousandths === 0 ? '—' : (overallRanked.gapTenThousandths / 10000).toFixed(3);
      intervalTenThousandths = overallRanked.gapTenThousandths;
    }
  }

  // Overall race time, unlike margin above, only ever changes for a driver
  // who received their OWN penalty this race — it's this driver's own laps
  // × own average lap (+ their own penalty), and no one else's penalty
  // changes how many laps or how fast THIS driver actually drove.
  let overallRaceTimeFormatted = row.overallRaceTimeFormatted;
  let overallRaceTimeTenThousandths = row.overallRaceTimeTenThousandths;
  if (pen && row.overallRaceTimeTenThousandths !== null) {
    const newTotal = row.overallRaceTimeTenThousandths + pen.time * 10000;
    overallRaceTimeTenThousandths = newTotal;
    overallRaceTimeFormatted = formatLapTime(newTotal / 10000);
  }

  // An entrant with no drivers row at all (see RaceResultRow.notInRoster's
  // own doc comment) is never scored — recalculate_race_scores() never
  // produced a race_scores row for them in the first place, so there's no
  // points formula to re-run here. Position/margin/tags are still real,
  // pipeline-sourced data and DO legitimately move when a penalty cascade
  // reshuffles the field around them (margin/overallRaceTime already
  // updated above), but they must never be handed real points just because
  // recomputeScorePoints would otherwise assign finishPointsForPosition to
  // whatever position they land on. Only ever true in the Overall view (see
  // notInRoster's own doc comment), so this never needs to touch class
  // points/positions.
  if (row.notInRoster) {
    return {
      ...row,
      position: newPosition,
      wasAdjusted: row.wasAdjusted || positionChanged,
      penaltyOldPosition: positionChanged ? row.position : row.penaltyOldPosition,
      hasPenalty: row.hasPenalty || Boolean(pen),
      margin,
      intervalTenThousandths,
      overallRaceTimeFormatted,
      overallRaceTimeTenThousandths,
      tags,
    };
  }

  if (!pen && !positionChanged && !classPositionChanged) {
    // Points/position genuinely untouched for this row — but margin/tags
    // above may still have changed via leader re-zeroing, so this can't
    // just return the original `row` unconditionally the way it used to.
    return { ...row, margin, intervalTenThousandths, tags };
  }

  const classified = !row.tags.includes('Unclassified');
  const canReposition = !row.dsq && classified && row.position !== null && format !== null;
  const effectivePosition = canReposition ? newPosition : row.position;

  const recomputed = recomputeScorePoints(
    {
      totalPoints: row.totalPoints,
      classPoints: row.classPoints,
      finesseBonus: row.finesseBonus,
      poleBonus: row.poleBonus,
      aggressionBonus: row.aggressionBonus,
      lapLedBonus: row.lapLedBonus,
      fewestIncidentsBonus: row.fewestIncidentsBonus,
      fastestLapBonus: row.fastestLapBonus,
      sprintSweepBonus: row.sprintSweepBonus,
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
    penaltyByRaceDriver,
    awardsClassPoints,
    pointsTables,
  );

  return {
    ...row,
    position: effectivePosition,
    classPoints: recomputed.classPoints,
    pointsDeduction: recomputed.pointsDeduction,
    bonusPoints:
      recomputed.classPoints +
      row.finesseBonus +
      row.poleBonus +
      row.aggressionBonus +
      row.lapLedBonus +
      row.fewestIncidentsBonus +
      row.fastestLapBonus +
      row.sprintSweepBonus +
      recomputed.pointsDeduction,
    totalPoints: recomputed.totalPoints,
    wasAdjusted: row.wasAdjusted || (canReposition && positionChanged),
    penaltyOldPosition: canReposition && positionChanged ? row.position : row.penaltyOldPosition,
    hasPenalty: row.hasPenalty || Boolean(pen),
    margin,
    intervalTenThousandths,
    overallRaceTimeFormatted,
    overallRaceTimeTenThousandths,
    tags,
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
  penalties: (PenaltyLike & {
    race_number: number;
    driver_id: string | null;
    session_type: 'race' | 'qualifying' | 'practice';
  })[],
  format: Format | null,
  /** classId -> whether that class awards the top-3-in-class Class Points bonus at all (false for Alpha) — see recomputeRow. A class missing from this map is treated as awarding it, matching every class besides Alpha. */
  classPointsEligibleByClassId: Map<number, boolean> = new Map(),
  /**
   * This round's season's scoring_rulesets.rules (see resolvePointsTables) —
   * lets a repositioned driver's new finish/class points be priced off the
   * SAME table the round was actually scored with, instead of the fixed
   * FINISH_POINTS/CLASS_POINTS tables. Left null (the default) for a caller
   * that hasn't been updated to fetch it, which keeps that caller on the
   * old fixed-table behavior exactly as before this param existed — never a
   * hard failure, just a less precise recompute.
   */
  rules: unknown = null,
  /** This round's subsession_id — only consulted for `rules`' own `race_overrides.subsession_ids` escape hatch (see resolvePointsTables). Unused (and harmless to omit) when `rules` is null. */
  subsessionId: number | null = null,
): RoundResults {
  if (penalties.length === 0) return results;
  const penaltyByRaceDriver = sumPenaltiesByRaceDriver(penalties);

  const raceNumbers = new Set<number>([
    ...results.overall.keys(),
    ...[...results.byClass.values()].flatMap((byRace) => [...byRace.keys()]),
  ]);

  const newOverall = new Map(results.overall);
  const newByClass = new Map(
    [...results.byClass].map(([classId, byRace]) => [classId, new Map(byRace)] as const),
  );

  const toPositionable = (rows: RaceResultRow[]): Positionable[] =>
    rows.map((r) => ({
      driverId: r.driver.id,
      position: r.position,
      intervalTenThousandths: r.intervalTenThousandths,
      lapsComplete: r.laps,
      averageLapTenThousandths: r.averageLapTenThousandths,
    }));

  for (const raceNumber of raceNumbers) {
    const overallRows = results.overall.get(raceNumber);
    if (!overallRows) continue;
    const touchedThisRace = overallRows.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driver.id}`));
    if (!touchedThisRace) continue;

    // The race's actual on-track leader (never a per-class one — see this
    // file's Position recalculation header) — every reorder pass for this
    // race, class-relative or overall, measures laps-down/race-time against
    // this same fixed reference point.
    const leaderRow = overallRows.find((r) => r.finishPosition === 1);
    const leader: LeaderRaceStats = {
      lapsComplete: leaderRow?.laps ?? null,
      averageLapTenThousandths: leaderRow?.averageLapTenThousandths ?? null,
    };

    const newOverallRanked = reorderByTimePenalty(
      toPositionable(overallRows),
      raceNumber,
      penaltyByRaceDriver,
      leader,
    );

    // Same table for every row in this race regardless of class — resolved
    // once per race rather than per driver (see resolvePointsTables).
    const pointsTables =
      format !== null && subsessionId !== null
        ? resolvePointsTables(rules, format, raceNumber, subsessionId)
        : { finishPoints: null, classPoints: null, classifiedMinimumFinishPoints: null };

    // Pass 1: recompute every class's new position order for this race, and
    // build one driver -> new-class-position lookup — the OVERALL view's
    // points recompute needs each driver's class position too (both views
    // share one underlying points total, they just group the same rows
    // differently), so this has to be gathered across all classes before
    // either view is actually written back.
    const positionsByClassId = new Map<number, Map<string, RankedPosition>>();
    const marginRankedByClassId = new Map<number, Map<string, RankedPosition>>();
    const newClassPositionByDriver = new Map<string, number>();
    const originalClassPositionByDriver = new Map<string, number>();
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = reorderByTimePenalty(
        toPositionable(classRows),
        raceNumber,
        penaltyByRaceDriver,
        leader,
      );
      positionsByClassId.set(classId, newPositions);
      for (const [driverId, ranked] of newPositions) newClassPositionByDriver.set(driverId, ranked.position);
      // `results` (as opposed to newByClass) still holds each row exactly
      // as getRoundResults() produced it — its own `position` field IS that
      // driver's original class position, for a class-view row.
      for (const row of classRows)
        if (row.position !== null) originalClassPositionByDriver.set(row.driver.id, row.position);

      // A second, display-only reorder for this class, measured against the
      // class's OWN leader (its pre-penalty position-1 row) instead of the
      // race's overall leader — this is what the Per Class view's margin
      // ("distance to the class leader") is sourced from below. Kept
      // entirely separate from `newPositions` above: position/laps-down/DSQ
      // classification must stay measured against the actual race leader
      // per rule 18.3.2 (see reorderByTimePenalty's own doc comment on why),
      // this is purely about what number is shown next to a driver's name.
      const classLeaderRow = classRows.find((r) => r.position === 1);
      const classLeader: LeaderRaceStats = {
        lapsComplete: classLeaderRow?.laps ?? null,
        averageLapTenThousandths: classLeaderRow?.averageLapTenThousandths ?? null,
      };
      marginRankedByClassId.set(
        classId,
        reorderByTimePenalty(toPositionable(classRows), raceNumber, penaltyByRaceDriver, classLeader),
      );
    }

    // Pass 2: write back recomputed rows for both views. The Overall view's
    // margin/overall-race-time always comes from the OVERALL reorder
    // (newOverallRanked); the Per Class view's comes from that class's own
    // margin-only reorder (marginRankedByClassId) instead, so it reads
    // distance to the class leader rather than the overall leader.
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = positionsByClassId.get(classId)!;
      const marginRanked = marginRankedByClassId.get(classId)!;
      newByClass.get(classId)!.set(
        raceNumber,
        classRows.map((row) =>
          recomputeRow(
            row,
            newPositions.get(row.driver.id)?.position ?? row.position,
            newClassPositionByDriver.get(row.driver.id) ?? null,
            originalClassPositionByDriver.get(row.driver.id) ?? null,
            raceNumber,
            format,
            penaltyByRaceDriver,
            marginRanked.get(row.driver.id),
            classPointsEligibleByClassId,
            pointsTables,
          ),
        ),
      );
    }

    newOverall.set(
      raceNumber,
      overallRows.map((row) =>
        recomputeRow(
          row,
          newOverallRanked.get(row.driver.id)?.position ?? row.position,
          newClassPositionByDriver.get(row.driver.id) ?? null,
          originalClassPositionByDriver.get(row.driver.id) ?? null,
          raceNumber,
          format,
          penaltyByRaceDriver,
          newOverallRanked.get(row.driver.id),
          classPointsEligibleByClassId,
          pointsTables,
        ),
      ),
    );
  }

  return { byClass: newByClass, overall: newOverall };
}
