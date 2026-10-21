import type { PenaltyLike } from './effective';
import { classPointsFromTables, finishPointsFromTables, resolvePointsTables, type Format } from './points';
import {
  reorderByTimePenalty,
  scoringRaceNumber,
  sumPenaltiesByRaceDriver,
  type LeaderRaceStats,
  type Positionable,
} from './reorder';

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
  aggressionBonus: number;
  pointsDeduction: number;
  /** This driver's own completed laps this race — see Positionable's own doc comment (results.ts's rawByKey). */
  lapsComplete: number | null;
  /** This driver's own average lap this race — see Positionable's own doc comment (results.ts's getLapStatsForSubsessions). */
  averageLapTenThousandths: number | null;
}

export interface SeasonOverallAdjustment {
  newPosition: number | null;
  finishPoints: number;
  pointsDeduction: number;
  /** finishPoints + finesseBonus + poleBonus + aggressionBonus + pointsDeduction — deliberately excluding class_points, matching computeOverallSeasonStandings' own points formula. */
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
  penalties: (PenaltyLike & {
    subsession_id: number;
    race_number: number;
    driver_id: string | null;
    session_type: 'race' | 'qualifying' | 'practice';
  })[],
  formatBySubsession: Map<number, Format | null>,
  /** This round's season's scoring_rulesets.rules, keyed by subsession_id — same shape as formatBySubsession, since a career-spanning caller (getDriverRaceHistory) can touch many seasons' worth of subsessions in one call, each potentially on a different ruleset. See resolvePointsTables/finishPointsFromTables above for why this matters: without it, a repositioned driver's new finishPoints was priced off the fixed FINISH_POINTS table instead of the season's actual (often very different) configured table. */
  rulesBySubsession: Map<number, unknown>,
): Map<string, SeasonOverallAdjustment> {
  const out = new Map<string, SeasonOverallAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) =>
    `${subsessionId}:${raceNumber}:${driverId}`;

  // Grouped by scoringRaceNumber (not the raw race_number) so a
  // qualifying/practice penalty (stored with the race_number sentinel 0)
  // lands in Race 1's bucket, same as a penalty logged directly against
  // Race 1 — see scoringRaceNumber's own doc comment above.
  const penaltiesByRace = new Map<
    string,
    (PenaltyLike & {
      subsession_id: number;
      race_number: number;
      driver_id: string | null;
      session_type: 'race' | 'qualifying' | 'practice';
    })[]
  >();
  for (const p of penalties) {
    const key = raceKey(p.subsession_id, scoringRaceNumber(p));
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
    const rules = rulesBySubsession.get(subsessionId) ?? null;
    const pointsTables =
      format !== null
        ? resolvePointsTables(rules, format, raceNumber, subsessionId)
        : { finishPoints: null, classPoints: null, classifiedMinimumFinishPoints: null };
    // reorderByTimePenalty's map key is scoped by raceNumber alone — safe
    // here because we only ever hand it this one race's own group/penalties.
    const penaltyByRaceDriver = sumPenaltiesByRaceDriver(
      racePenalties.map((p) => ({ ...p, race_number: raceNumber })),
    );
    // Only actually reorder this group if one of ITS OWN drivers has a
    // penalty — `racePenalties` can be nonempty just because some OTHER
    // class's driver was penalized in this same race. Reordering by interval
    // even with an all-zero penalty map isn't guaranteed byte-identical to
    // the original raw-position sort (ties/pipeline quirks), so skipping
    // untouched groups entirely avoids spurious position/point changes.
    const touched = group.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driverId}`));
    if (!touched) continue;

    // `group` already spans every class for this (subsession, race) — see
    // this function's own doc comment ("cross-class pass") — so the race's
    // actual leader can be found right inside it, same convention as
    // applyPenaltiesToRoundResults uses (position 1, pre-penalty).
    const leaderRow = group.find((r) => r.scoredPosition === 1);
    const leader: LeaderRaceStats = {
      lapsComplete: leaderRow?.lapsComplete ?? null,
      averageLapTenThousandths: leaderRow?.averageLapTenThousandths ?? null,
    };

    const positionable: Positionable[] = group
      .filter((r) => !r.dsq && r.scoredPosition !== null)
      .map((r) => ({
        driverId: r.driverId,
        position: r.scoredPosition,
        intervalTenThousandths: r.intervalTenThousandths,
        lapsComplete: r.lapsComplete,
        averageLapTenThousandths: r.averageLapTenThousandths,
      }));
    const newPositions = reorderByTimePenalty(positionable, raceNumber, penaltyByRaceDriver, leader);

    for (const r of group) {
      const pen = penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`);
      const newPosition = newPositions.get(r.driverId)?.position ?? r.scoredPosition;
      const positionChanged = newPosition !== r.scoredPosition;
      if (!pen && !positionChanged) continue;

      const canReposition = !r.dsq && r.classified && format !== null;
      const finishPoints =
        canReposition && positionChanged && newPosition !== null
          ? finishPointsFromTables(format as Format, newPosition, pointsTables)
          : r.finishPoints;
      const pointsDeduction = r.pointsDeduction - (pen?.points ?? 0);
      const overallTotalPoints =
        finishPoints + r.finesseBonus + r.poleBonus + r.aggressionBonus + pointsDeduction;

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
  aggressionBonus: number;
  /** Like aggressionBonus above — untouched by any penalty (0067_ruleset_overhaul_and_bonuses.sql), only ever read here to back out/reconstruct totalPoints. */
  lapLedBonus: number;
  fewestIncidentsBonus: number;
  fastestLapBonus: number;
  sprintSweepBonus: number;
  pointsDeduction: number;
  /** This driver's own completed laps this race — see Positionable's own doc comment. */
  lapsComplete: number | null;
  /** This driver's own average lap this race — see Positionable's own doc comment. */
  averageLapTenThousandths: number | null;
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
  penalties: (PenaltyLike & {
    subsession_id: number;
    race_number: number;
    driver_id: string | null;
    session_type: 'race' | 'qualifying' | 'practice';
  })[],
  formatBySubsession: Map<number, Format | null>,
  overallAdjustments: Map<string, SeasonOverallAdjustment>,
  /**
   * The race's actual (never per-class) leader's stats, keyed
   * `${subsessionId}:${raceNumber}` — unlike computeSeasonOverallAdjustments,
   * this function's own `rows` are already filtered to one class, so the
   * overall leader (who may well race in a DIFFERENT class) can't always be
   * found inside them. Built once by results.ts's getSeasonOverallContext
   * from its own cross-class data and shared across every class's pass —
   * see this file's Position recalculation header on why it must be the
   * same leader every time.
   */
  leaderStatsByRace: Map<string, LeaderRaceStats>,
  /** Whether THIS class (every row here is already filtered to one class — see this function's own doc comment) awards the top-3-in-class Class Points bonus at all — false for Alpha. */
  awardsClassPoints: boolean,
  /** Same as computeSeasonOverallAdjustments' own `rulesBySubsession` param — see that function's doc comment. */
  rulesBySubsession: Map<number, unknown>,
): Map<string, SeasonClassAdjustment> {
  const out = new Map<string, SeasonClassAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) =>
    `${subsessionId}:${raceNumber}:${driverId}`;

  // Same scoringRaceNumber grouping as computeSeasonOverallAdjustments above
  // — a qualifying/practice penalty lands in Race 1's bucket for this class
  // pass too.
  const penaltiesByRace = new Map<
    string,
    (PenaltyLike & {
      subsession_id: number;
      race_number: number;
      driver_id: string | null;
      session_type: 'race' | 'qualifying' | 'practice';
    })[]
  >();
  for (const p of penalties) {
    const key = raceKey(p.subsession_id, scoringRaceNumber(p));
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
    const rules = rulesBySubsession.get(subsessionId) ?? null;
    const pointsTables =
      format !== null
        ? resolvePointsTables(rules, format, raceNumber, subsessionId)
        : { finishPoints: null, classPoints: null, classifiedMinimumFinishPoints: null };
    const penaltyByRaceDriver = sumPenaltiesByRaceDriver(
      racePenalties.map((p) => ({ ...p, race_number: raceNumber })),
    );
    // Same reasoning as computeSeasonOverallAdjustments: only reorder this
    // class's group if one of ITS OWN drivers was actually penalized.
    const touched = group.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driverId}`));
    if (!touched) continue;

    const leader: LeaderRaceStats = leaderStatsByRace.get(key) ?? {
      lapsComplete: null,
      averageLapTenThousandths: null,
    };

    const positionable: Positionable[] = group
      .filter((r) => !r.dsq && r.classPosition !== null)
      .map((r) => ({
        driverId: r.driverId,
        position: r.classPosition,
        intervalTenThousandths: r.intervalTenThousandths,
        lapsComplete: r.lapsComplete,
        averageLapTenThousandths: r.averageLapTenThousandths,
      }));
    const newClassPositions = reorderByTimePenalty(positionable, raceNumber, penaltyByRaceDriver, leader);

    for (const r of group) {
      const pen = penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`);
      const newClassPosition = newClassPositions.get(r.driverId)?.position ?? r.classPosition;
      const classPositionChanged = newClassPosition !== r.classPosition;
      if (!pen && !classPositionChanged) continue;

      const canReposition = !r.dsq && r.classified && format !== null;
      const overall = overallAdjustments.get(rowKey(r.subsessionId, r.raceNumber, r.driverId));
      const finishPoints = overall
        ? overall.finishPoints
        : r.totalPoints -
          r.classPoints -
          r.finesseBonus -
          r.poleBonus -
          r.aggressionBonus -
          r.lapLedBonus -
          r.fewestIncidentsBonus -
          r.fastestLapBonus -
          r.sprintSweepBonus -
          r.pointsDeduction;
      const pointsDeduction = overall ? overall.pointsDeduction : r.pointsDeduction - (pen?.points ?? 0);
      const classPoints =
        canReposition && classPositionChanged
          ? classPointsFromTables(format as Format, newClassPosition, awardsClassPoints, pointsTables)
          : r.classPoints;
      const totalPoints =
        finishPoints +
        classPoints +
        r.finesseBonus +
        r.poleBonus +
        r.aggressionBonus +
        r.lapLedBonus +
        r.fewestIncidentsBonus +
        r.fastestLapBonus +
        r.sprintSweepBonus +
        pointsDeduction;

      out.set(rowKey(r.subsessionId, r.raceNumber, r.driverId), {
        newClassPosition: canReposition ? newClassPosition : r.classPosition,
        totalPoints,
      });
    }
  }

  return out;
}
