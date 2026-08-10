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
import { formatLapTime } from './supabase';

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

/**
 * The Class Points top-3-in-class bonus (0 outside the top 3). `awardsClassPoints`
 * defaults to true for backward compatibility, but every internal caller
 * passes it explicitly — Alpha's own scoring never includes this bonus (it's
 * Gamma/Delta's own per-race class-position bonus, see README), so a driver
 * in a non-awarding class always gets 0 here regardless of class position.
 */
export function classPointsForPosition(format: Format, classPosition: number | null, awardsClassPoints: boolean = true): number {
  if (!awardsClassPoints) return 0;
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
// Position recalculation — rulebook 18.3.1/18.3.2: "Drivers are classified
// first by completed laps, then by total race time... When a driver
// receives a time penalty, it is added to their total race time. If the
// added penalty places the driver more than a full lap behind the leader —
// measured by the leader's final lap pace — the driver is scored +1 lap
// down. The driver is then classified on that lap and ranked by its total
// race time."
//
// A driver still on the lead lap has a real, exact gap-to-leader
// (`intervalTenThousandths`, iRacing's own telemetry) — adding a time
// penalty to that and re-sorting is exact, no estimation involved. A driver
// already laps down has NO usable real gap (`intervalTenThousandths` is
// just iRacing's "-xL" flag there, not a time — see CuratedRaceResultRow in
// results.ts), which used to mean a penalty against a laps-down driver had
// nothing to compare it to and simply did nothing (the gap this whole
// feature closes). Per Logan, the fix is the same one used by hand before
// this was automated: each driver's own "overall race time" = their own
// completed laps × their own average lap pace
// (`average_lap_ten_thousandths`, see results.ts's getLapStatsForSubsessions
// — an isolated fetch, so missing data degrades this one calculation, never
// the rest of the site). That estimate is ONLY used where there's no exact
// data to prefer: laps-down drivers, and detecting whether a lead-lap
// driver's penalty is big enough to cross them into (or further into) laps-
// down territory — one lap's worth of time being the leader's own average
// lap, our best available stand-in for "the leader's final lap pace" (the
// pipeline doesn't capture a literal last-lap time).
// ---------------------------------------------------------------------------

interface RaceDriverPenaltyTotal {
  time: number; // seconds
  points: number; // flat championship-points deduction
}

/** Sums every penalty logged against each (race_number, driver) pair in this round — a driver can accumulate more than one penalty for the same race, and their effects stack. Uses each penalty's effective (appeal-aware) time/points. A Racing Incident entry (driver_id null — see supabase.ts's Penalty.driver_id) collapses into one harmless `"${raceNumber}:null"` bucket that no real driver's id can ever match, so it's never looked up — a no-fault entry simply can't apply to anyone. */
export function sumPenaltiesByRaceDriver(
  penalties: (PenaltyLike & { race_number: number; driver_id: string | null })[]
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
  /** This driver's own completed laps this race — null when not recorded. */
  lapsComplete: number | null;
  /** This driver's own average lap this race (ten-thousandths of a second) — null when the pipeline hasn't got it for this driver/race (see results.ts's getLapStatsForSubsessions). */
  averageLapTenThousandths: number | null;
}

/** The race's overall leader's own stats — the fixed reference point every driver in the race (any class) is measured against, laps-down-wise. Always the actual on-track race leader, never a per-class one — see this section's header. */
export interface LeaderRaceStats {
  lapsComplete: number | null;
  averageLapTenThousandths: number | null;
}

export interface RankedPosition {
  position: number;
  /** This driver's laps-down count after applying any penalty — 0 means still on the lead lap. */
  lapsDown: number;
  /** Their laps-down count BEFORE any penalty (from completed laps alone) — compare against `lapsDown` to tell whether a penalty actually pushed them further down, vs. them just already being there independent of any penalty. */
  lapsDownBefore: number;
  /**
   * A same-formula-comparable time value used to rank this driver against
   * others in the same lapsDown group — not comparable across two rows with
   * different lapsDown counts (see reorderByTimePenalty's own comments for
   * exactly how it's derived in each case). For the lapsDown === 0 (lead
   * lap) group specifically, this IS the driver's real, displayable margin:
   * re-zeroed against whichever row actually has the smallest value now,
   * so the current leader — even a penalized one who kept the win — always
   * reads exactly 0. Null when there wasn't enough data to compute one at
   * all, in which case this row simply keeps its original relative position
   * among its lapsDown peers.
   */
  gapTenThousandths: number | null;
}

/**
 * Re-ranks one race's rows (either the overall field or one class's slice
 * of it) after adding each penalized driver's time penalty to their total
 * race time, per rules 18.3.1/18.3.2 (this section's header). Rows without
 * a position (DSQ'd/unranked) are left out entirely. `leader` should always
 * be the race's actual overall leader's stats, even when `rows` is just one
 * class's slice — see this section's header on why.
 */
export function reorderByTimePenalty(
  rows: Positionable[],
  raceNumber: number,
  penaltyByRaceDriver: Map<string, RaceDriverPenaltyTotal>,
  leader: LeaderRaceStats
): Map<string, RankedPosition> {
  const ranked = rows.filter((r) => r.position !== null);

  interface SortKey {
    driverId: string;
    lapsDown: number;
    lapsDownBefore: number;
    gap: number | null;
    /**
     * Whether THIS row actually carries a real penalty (as opposed to
     * having a `gap` that's only there to serve as a same-formula
     * comparison baseline for a row that DID get penalized — see the
     * comparator below). Two untouched rows must never reorder relative to
     * each other off of the laps-down estimate's noise; only a real
     * penalty should ever move someone.
     */
    touched: boolean;
    originalPosition: number;
  }

  const keys: SortKey[] = ranked.map((r) => {
    const originalPosition = r.position as number;
    const timePenaltyTenThousandths = (penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`)?.time ?? 0) * 10000;
    const touched = timePenaltyTenThousandths !== 0;
    const lapsDownBefore =
      r.lapsComplete !== null && leader.lapsComplete !== null && leader.lapsComplete > r.lapsComplete
        ? leader.lapsComplete - r.lapsComplete
        : 0;
    const onLeadLapBefore = lapsDownBefore === 0 && r.intervalTenThousandths !== null && r.intervalTenThousandths >= 0;

    if (onLeadLapBefore) {
      if (!touched) {
        // Untouched lead-lap driver — keep the pipeline's own exact interval.
        return { driverId: r.driverId, lapsDown: 0, lapsDownBefore, gap: r.intervalTenThousandths, touched, originalPosition };
      }
      // Exact: real interval + a real penalty, no averaging involved.
      const newInterval = (r.intervalTenThousandths as number) + timePenaltyTenThousandths;
      if (leader.averageLapTenThousandths !== null && leader.averageLapTenThousandths > 0 && newInterval > leader.averageLapTenThousandths) {
        const lapsDown = Math.floor(newInterval / leader.averageLapTenThousandths);
        return { driverId: r.driverId, lapsDown, lapsDownBefore, gap: newInterval - lapsDown * leader.averageLapTenThousandths, touched, originalPosition };
      }
      return { driverId: r.driverId, lapsDown: 0, lapsDownBefore, gap: newInterval, touched, originalPosition };
    }

    // Already laps down (before this penalty, or after — doesn't matter
    // here) — there's no real per-driver gap to lean on (see this
    // section's header), so EVERY row in this bucket is measured the same
    // way: own completed laps × own average lap vs the leader's, whether
    // or not THIS specific row was penalized. That's deliberate — a
    // penalized driver's estimate is only meaningful when it can be
    // compared against a real number for its untouched neighbors too;
    // comparing it against a bare "no penalty here" placeholder (the old
    // behavior) meant a penalized driver's estimate — whatever its actual
    // size — always sorted ahead of every untouched laps-down row, which
    // is the bug this comment used to paper over: a small penalty could
    // vault a driver to the very front of the whole laps-down field. The
    // comparator below still protects two UNTOUCHED rows from ever
    // reordering relative to each other off of this estimate's noise —
    // only a row that's actually being penalized gets ranked by it.
    if (
      r.averageLapTenThousandths !== null &&
      r.lapsComplete !== null &&
      leader.averageLapTenThousandths !== null &&
      leader.averageLapTenThousandths > 0 &&
      leader.lapsComplete !== null
    ) {
      const ownRaceTime = r.lapsComplete * r.averageLapTenThousandths;
      const leaderRaceTime = leader.lapsComplete * leader.averageLapTenThousandths;
      const gapAfter = ownRaceTime - leaderRaceTime + timePenaltyTenThousandths;
      // A penalty only ever adds laps down, never removes one the pipeline
      // already recorded — guards against the estimate's own noise
      // undercutting a laps-down count we already know is at least this.
      const lapsDown = Math.max(lapsDownBefore, Math.floor(gapAfter / leader.averageLapTenThousandths));
      return { driverId: r.driverId, lapsDown, lapsDownBefore, gap: gapAfter, touched, originalPosition };
    }

    // Missing average-lap data for this row or the leader — can't estimate,
    // so this row keeps its pre-penalty laps-down bucket (the penalty's
    // POINTS effect, if any, still applies via recomputeRow — only the
    // re-ranking is skipped here for lack of data to rank it by).
    return { driverId: r.driverId, lapsDown: lapsDownBefore, lapsDownBefore, gap: null, touched, originalPosition };
  });

  // Re-zero the lead-lap group's gap against whoever actually has the
  // smallest one now, not whoever had it before any penalty. Every lead-lap
  // row's gap above is "own original interval + own penalty" — i.e. total
  // race time relative to the OLD leader's time as a zero point — which is
  // exactly right for sorting (a constant offset never changes relative
  // order) but wrong for DISPLAY once the actual leader was one of the
  // penalized rows: if the leader picks up a penalty small enough to keep
  // the win, their own gap above becomes their own penalty time (nonzero)
  // instead of 0, and everyone else's gap is still measured against the
  // leader's OLD (pre-penalty) time rather than their new, slower one. Both
  // are wrong the same way: the leader should always show a 0 margin, and
  // the rest of the field should shift by exactly the leader's penalty.
  // Subtracting the new minimum from every lead-lap row's gap fixes both at
  // once, and does so correctly however the reordering actually shook out
  // — including a big enough leader penalty handing the win to someone else
  // entirely, in which case every gap re-zeroes against THEM instead.
  const leadLapGaps = keys.filter((k) => k.lapsDown === 0 && k.gap !== null).map((k) => k.gap as number);
  if (leadLapGaps.length > 0) {
    const newLeaderGap = Math.min(...leadLapGaps);
    if (newLeaderGap !== 0) {
      for (const k of keys) {
        if (k.lapsDown === 0 && k.gap !== null) k.gap -= newLeaderGap;
      }
    }
  }

  keys.sort((a, b) => {
    if (a.lapsDown !== b.lapsDown) return a.lapsDown - b.lapsDown;
    // Neither row was actually penalized — always keep their original
    // relative order (the pipeline's own, more precise, telemetry-based
    // ordering) rather than let the laps-down estimate's noise reshuffle
    // two drivers nothing happened to, just because some OTHER driver in
    // the race got a penalty and triggered this recompute.
    if (!a.touched && !b.touched) return a.originalPosition - b.originalPosition;
    if (a.gap !== null && b.gap !== null && a.gap !== b.gap) return a.gap - b.gap;
    return a.originalPosition - b.originalPosition;
  });

  const out = new Map<string, RankedPosition>();
  keys.forEach((k, i) =>
    out.set(k.driverId, { position: i + 1, lapsDown: k.lapsDown, lapsDownBefore: k.lapsDownBefore, gapTenThousandths: k.gap })
  );
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
  /** Like finesseBonus/poleBonus — a penalty never touches this (recalculate_race_scores() computes it off the officially-adjusted position, upstream of any of this file's own display-time recompute), so it only ever needs to be read here, never written. */
  aggressionBonus: number;
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
  awardsClassPoints: boolean
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
  const originalFinishPoints = s.totalPoints - s.classPoints - s.finesseBonus - s.poleBonus - s.aggressionBonus - s.pointsDeduction;
  const finishPoints =
    canReposition && positionChanged && newPosition !== null
      ? finishPointsForPosition(format as Format, newPosition)
      : originalFinishPoints;

  // Same reasoning as finishPoints: only ever consult our own CLASS_POINTS
  // table for a driver whose class position actually moved — everyone else
  // keeps the pipeline's original class_points untouched. Gated on
  // awardsClassPoints too, so a podium shuffle in a class that never earns
  // this bonus (Alpha) can never manufacture nonzero class points the
  // original pipeline data would never have had.
  const classPoints =
    canReposition && classPositionChanged
      ? classPointsForPosition(format as Format, newClassPosition, awardsClassPoints)
      : s.classPoints;

  const pointsDeduction = s.pointsDeduction - (pen?.points ?? 0);
  const totalPoints = finishPoints + classPoints + s.finesseBonus + s.poleBonus + s.aggressionBonus + pointsDeduction;

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
   * The OVERALL (never class-relative) reordering result for this driver
   * this race, used to refresh margin/tags display — for EVERY row in a
   * touched race, not just ones with their own penalty, since the leader
   * a margin is measured against can itself change (see this file's
   * Position recalculation header on why margin is always measured against
   * the actual race leader regardless of which view — class or overall — a
   * row belongs to). Undefined when the race wasn't reordered at all.
   */
  overallRanked: RankedPosition | undefined,
  /** classId -> whether that class awards the top-3-in-class Class Points bonus at all (false for Alpha) — looked up via row.classId, which is always this row's own class whether it came from the byClass loop or the overall loop. */
  classPointsEligibleByClassId: Map<number, boolean>
): RaceResultRow {
  const awardsClassPoints = classPointsEligibleByClassId.get(row.classId) ?? true;
  const pen = penaltyByRaceDriver.get(`${raceNumber}:${row.driver.id}`);
  const positionChanged = newPosition !== row.position;
  const classPositionChanged = newClassPosition !== originalClassPosition;

  // Margin/tags are always measured against the CURRENT overall leader
  // (reorderByTimePenalty re-zeroes the lead-lap group against whoever
  // actually has the smallest total time now — see its own comments), so
  // ANY row's margin can change even if that row itself was never
  // penalized and never moved position: if the actual leader picked up a
  // penalty small enough to keep the win, their own margin drops to 0 and
  // everyone else's shifts by exactly the leader's penalty, all without
  // anyone's relative ORDER (or points) changing at all. So this can't be
  // gated on `pen` or a position change the way points/position below are.
  let margin = row.margin;
  let intervalTenThousandths = row.intervalTenThousandths;
  let tags = row.tags;
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
      margin = overallRanked.gapTenThousandths === 0 ? '—' : (overallRanked.gapTenThousandths / 10000).toFixed(3);
      intervalTenThousandths = overallRanked.gapTenThousandths;
    }
    // Only flag this when the penalty ITSELF pushed them further down than
    // their completed laps already had them — an already-laps-down driver
    // who got, say, a PP-only penalty this race (no time effect, or not
    // enough to cross another boundary) shouldn't read as if the penalty
    // caused a laps-down status they already had independent of it. Stays
    // false for an untouched row regardless of any leader re-zeroing above,
    // since that row's OWN lapsDown/lapsDownBefore never differ without its
    // own penalty (see reorderByTimePenalty).
    if (overallRanked.lapsDown > overallRanked.lapsDownBefore) {
      tags = [...tags, `${overallRanked.lapsDown} Lap${overallRanked.lapsDown > 1 ? 's' : ''} Down (Penalty)`];
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
    awardsClassPoints
  );

  return {
    ...row,
    position: effectivePosition,
    classPoints: recomputed.classPoints,
    pointsDeduction: recomputed.pointsDeduction,
    bonusPoints: recomputed.classPoints + row.finesseBonus + row.poleBonus + row.aggressionBonus + recomputed.pointsDeduction,
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
  penalties: (PenaltyLike & { race_number: number; driver_id: string | null })[],
  format: Format | null,
  /** classId -> whether that class awards the top-3-in-class Class Points bonus at all (false for Alpha) — see recomputeRow. A class missing from this map is treated as awarding it, matching every class besides Alpha. */
  classPointsEligibleByClassId: Map<number, boolean> = new Map()
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

    const newOverallRanked = reorderByTimePenalty(toPositionable(overallRows), raceNumber, penaltyByRaceDriver, leader);

    // Pass 1: recompute every class's new position order for this race, and
    // build one driver -> new-class-position lookup — the OVERALL view's
    // points recompute needs each driver's class position too (both views
    // share one underlying points total, they just group the same rows
    // differently), so this has to be gathered across all classes before
    // either view is actually written back.
    const positionsByClassId = new Map<number, Map<string, RankedPosition>>();
    const newClassPositionByDriver = new Map<string, number>();
    const originalClassPositionByDriver = new Map<string, number>();
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = reorderByTimePenalty(toPositionable(classRows), raceNumber, penaltyByRaceDriver, leader);
      positionsByClassId.set(classId, newPositions);
      for (const [driverId, ranked] of newPositions) newClassPositionByDriver.set(driverId, ranked.position);
      // `results` (as opposed to newByClass) still holds each row exactly
      // as getRoundResults() produced it — its own `position` field IS that
      // driver's original class position, for a class-view row.
      for (const row of classRows) if (row.position !== null) originalClassPositionByDriver.set(row.driver.id, row.position);
    }

    // Pass 2: write back recomputed rows for both views. Margin/overall-
    // race-time always come from the OVERALL reorder (newOverallRanked),
    // regardless of which view a row belongs to.
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      const newPositions = positionsByClassId.get(classId)!;
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
            newOverallRanked.get(row.driver.id),
            classPointsEligibleByClassId
          )
        )
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
          classPointsEligibleByClassId
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
  penalties: (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string | null })[],
  formatBySubsession: Map<number, Format | null>
): Map<string, SeasonOverallAdjustment> {
  const out = new Map<string, SeasonOverallAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) => `${subsessionId}:${raceNumber}:${driverId}`;

  const penaltiesByRace = new Map<string, (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string | null })[]>();
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
          ? finishPointsForPosition(format as Format, newPosition)
          : r.finishPoints;
      const pointsDeduction = r.pointsDeduction - (pen?.points ?? 0);
      const overallTotalPoints = finishPoints + r.finesseBonus + r.poleBonus + r.aggressionBonus + pointsDeduction;

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
  penalties: (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string | null })[],
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
  awardsClassPoints: boolean
): Map<string, SeasonClassAdjustment> {
  const out = new Map<string, SeasonClassAdjustment>();
  if (penalties.length === 0) return out;

  const raceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
  const rowKey = (subsessionId: number, raceNumber: number, driverId: string) => `${subsessionId}:${raceNumber}:${driverId}`;

  const penaltiesByRace = new Map<string, (PenaltyLike & { subsession_id: number; race_number: number; driver_id: string | null })[]>();
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

    const leader: LeaderRaceStats = leaderStatsByRace.get(key) ?? { lapsComplete: null, averageLapTenThousandths: null };

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
      const finishPoints = overall ? overall.finishPoints : r.totalPoints - r.classPoints - r.finesseBonus - r.poleBonus - r.aggressionBonus - r.pointsDeduction;
      const pointsDeduction = overall ? overall.pointsDeduction : r.pointsDeduction - (pen?.points ?? 0);
      const classPoints =
        canReposition && classPositionChanged
          ? classPointsForPosition(format as Format, newClassPosition, awardsClassPoints)
          : r.classPoints;
      const totalPoints = finishPoints + classPoints + r.finesseBonus + r.poleBonus + r.aggressionBonus + pointsDeduction;

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
