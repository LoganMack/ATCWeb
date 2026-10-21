/**
 * DOCUMENTED SIMPLIFICATIONS (deliberately out of scope for this pass):
 *   - Rule 64's "a large enough time penalty pushes a driver a full lap
 *     down" conversion isn't modeled — this file only re-sorts a
 *     time-penalized driver within their existing lead-lap-or-laps-down
 *     group (see reorderByTimePenalty below), since the app has no
 *     per-driver lap-time data to convert seconds into laps. A penalty
 *     large enough to plausibly cross that boundary should be
 *     double-checked manually.
 */

import { effectivePointsPenalty, effectiveTimePenaltySeconds, type PenaltyLike } from './effective';

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

export interface RaceDriverPenaltyTotal {
  time: number; // seconds
  points: number; // flat championship-points deduction
}

/**
 * Which real race a penalty's time/points/PP actually lands on for scoring
 * purposes. Qualifying/practice incidents are stored with race_number
 * pinned to the sentinel 0 (0056_penalty_session_type.sql) purely so they
 * group into their own "Qualifying"/"Practice" sections on the Incident
 * Report — that's a display/grouping concern, not a scoring one. Per Logan,
 * a qualifying/practice incident's own penalty (offenses, PP, time, points)
 * always applies to Race 1, same as if it had been logged directly against
 * it, so every place below that keys a penalty by race for scoring reads
 * this instead of the raw race_number.
 */
export function scoringRaceNumber(p: {
  session_type: 'race' | 'qualifying' | 'practice';
  race_number: number;
}): number {
  return p.session_type === 'race' ? p.race_number : 1;
}

/** Sums every penalty logged against each (race, driver) pair in this round — a driver can accumulate more than one penalty for the same race, and their effects stack. Uses each penalty's effective (appeal-aware) time/points, keyed by scoringRaceNumber (above) rather than the raw race_number, so a qualifying/practice penalty's time/points correctly stack onto Race 1 alongside anything logged directly against Race 1. A Racing Incident entry (driver_id null — see supabase.ts's Penalty.driver_id) collapses into one harmless `"${raceNumber}:null"` bucket that no real driver's id can ever match, so it's never looked up — a no-fault entry simply can't apply to anyone. */
export function sumPenaltiesByRaceDriver(
  penalties: (PenaltyLike & {
    race_number: number;
    driver_id: string | null;
    session_type: 'race' | 'qualifying' | 'practice';
  })[],
): Map<string, RaceDriverPenaltyTotal> {
  const out = new Map<string, RaceDriverPenaltyTotal>();
  for (const p of penalties) {
    const key = `${scoringRaceNumber(p)}:${p.driver_id}`;
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
  leader: LeaderRaceStats,
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
    const timePenaltyTenThousandths =
      (penaltyByRaceDriver.get(`${raceNumber}:${r.driverId}`)?.time ?? 0) * 10000;
    const touched = timePenaltyTenThousandths !== 0;
    const lapsDownBefore =
      r.lapsComplete !== null && leader.lapsComplete !== null && leader.lapsComplete > r.lapsComplete
        ? leader.lapsComplete - r.lapsComplete
        : 0;
    const onLeadLapBefore =
      lapsDownBefore === 0 && r.intervalTenThousandths !== null && r.intervalTenThousandths >= 0;

    if (onLeadLapBefore) {
      if (!touched) {
        // Untouched lead-lap driver — keep the pipeline's own exact interval.
        return {
          driverId: r.driverId,
          lapsDown: 0,
          lapsDownBefore,
          gap: r.intervalTenThousandths,
          touched,
          originalPosition,
        };
      }
      // Exact: real interval + a real penalty, no averaging involved.
      const newInterval = (r.intervalTenThousandths as number) + timePenaltyTenThousandths;
      if (
        leader.averageLapTenThousandths !== null &&
        leader.averageLapTenThousandths > 0 &&
        newInterval > leader.averageLapTenThousandths
      ) {
        const lapsDown = Math.floor(newInterval / leader.averageLapTenThousandths);
        return {
          driverId: r.driverId,
          lapsDown,
          lapsDownBefore,
          gap: newInterval - lapsDown * leader.averageLapTenThousandths,
          touched,
          originalPosition,
        };
      }
      return {
        driverId: r.driverId,
        lapsDown: 0,
        lapsDownBefore,
        gap: newInterval,
        touched,
        originalPosition,
      };
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
    return {
      driverId: r.driverId,
      lapsDown: lapsDownBefore,
      lapsDownBefore,
      gap: null,
      touched,
      originalPosition,
    };
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
    out.set(k.driverId, {
      position: i + 1,
      lapsDown: k.lapsDown,
      lapsDownBefore: k.lapsDownBefore,
      gapTenThousandths: k.gap,
    }),
  );
  return out;
}
