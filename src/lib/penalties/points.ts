/**
 * Post-race penalties (rulebook 18.3, section 5 "Stewarding") — turning a
 * steward's decision into a recalculated race result, season standings, and
 * a driver's running season penalty-points (PP) tally.
 *
 * Two separate systems share the word "points" here:
 *   - Championship/race points (finish_points, class_points, etc. — what the
 *     standings pages total up). A penalty can flatly deduct from these
 *     (`points_penalty` on a Penalty row) and/or indirectly change them by
 *     moving the driver's finishing position (`time_penalty_seconds`).
 *   - Penalty points (PP) — a season-long behavioral tally, capped at
 *     `drivers.penalty_points_max` (11 per the rulebook), that drives bans
 *     and probation. Entirely separate from race points in both directions.
 *     PP (and warning counts) are SEASON-scoped — see computeSeasonPPState
 *     below — while probation itself, once entered, runs on its own
 *     calendar clock independent of season boundaries (rule 61).
 */

// ---------------------------------------------------------------------------
// Points tables — Table: Points System, Table: Class Points (rulebook 18.3)
// ---------------------------------------------------------------------------

export type Format = 'endurance' | 'sprint';

/** Index 0 = position 1. Position 40 is the last explicit row; anyone classified beyond it gets CLASSIFIED_FALLBACK_POINTS instead (rule 31: "drivers who finish outside the points but above the >50% threshold earn minimum points"). */
const FINISH_POINTS: Record<Format, number[]> = {
  endurance: [
    200, 190, 180, 170, 162, 154, 146, 138, 130, 122, 114, 108, 102, 96, 90, 84, 78, 72, 66, 60, 54, 50, 46,
    42, 38, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6,
  ],
  sprint: [
    100, 95, 90, 85, 81, 77, 73, 69, 65, 61, 57, 54, 51, 48, 45, 42, 39, 36, 33, 30, 27, 25, 23, 21, 19, 17,
    16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
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
export function classPointsForPosition(
  format: Format,
  classPosition: number | null,
  awardsClassPoints: boolean = true,
): number {
  if (!awardsClassPoints) return 0;
  if (classPosition === null || classPosition < 1 || classPosition > CLASS_POINTS[format].length) return 0;
  return CLASS_POINTS[format][classPosition - 1];
}

// ---------------------------------------------------------------------------
// Ruleset-aware points tables — a season's actual scoring_rulesets.rules can
// (and, per Logan's own live data, does) configure base_points/class_podium
// tables completely different from the fixed FINISH_POINTS/CLASS_POINTS
// tables above, including separate tables for sprint Race 2+/Race 3 and a
// per-subsession `race_overrides` escape hatch — the exact same lookup
// recalculate_race_scores() (the DB pipeline) does when it FIRST scores a
// round. The fixed tables above are only ever the pipeline's OWN defaults
// from before rulesets were configurable, and this file's live recompute
// (a driver's own position moving, or a cascade from someone else's) is the
// only place besides that SQL function that ever needs to price a NEW
// position — so it's the only place this drift could ever bite. Confirmed
// in production: a "gained a position from someone else's penalty" driver's
// Penalty Adjustment coming out negative (even reading "-1" for a small
// gain) traced back to exactly this — pricing their new position off the
// wrong table swamped the real, correct (positive) points swing. See
// finishPointsFromTables/classPointsFromTables below for where this
// actually gets used; resolvePointsTables itself just mirrors the SQL
// side's own CASE logic so the two can never independently drift again.
// ---------------------------------------------------------------------------

export interface RacePointsTables {
  /** This race's actual finish-points-by-position table, or null when the ruleset doesn't resolve one (missing/malformed `rules` — finishPointsFromTables then falls back to the fixed FINISH_POINTS table below, same as before this existed). */
  finishPoints: number[] | null;
  /** This race's actual class-podium (top-3-in-class) table, same fallback story. */
  classPoints: number[] | null;
  /** The flat award for a classified driver whose position falls past `finishPoints`' own length (SQL's `classified_minimum`) — null when unresolved. */
  classifiedMinimumFinishPoints: number | null;
}

function toNumberArray(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const nums = v.map((n) => (typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Resolves the actual base_points/class_podium/classified_minimum tables a
 * given (subsession, race, format) combination scores with, mirroring
 * recalculate_race_scores()'s own SQL CASE logic exactly: a per-subsession
 * `race_overrides` entry first (currently unused by any live ruleset, but
 * the config shape supports it), then sprint's own Race 3 / Race 2+ variant
 * table, then the format's plain table. `rules` is a season's
 * scoring_rulesets.rules — untyped JSONB (see ScoringRuleset.rules' own doc
 * comment on why) — so every field read here is defensively validated
 * rather than trusted; anything malformed or missing just resolves to null,
 * which the caller (finishPointsFromTables/classPointsFromTables) treats as
 * "fall back to the fixed table" rather than throwing.
 */
export function resolvePointsTables(
  rules: unknown,
  format: Format,
  raceNumber: number,
  subsessionId: number,
): RacePointsTables {
  const r = rules as
    | {
        base_points?: Record<string, unknown>;
        class_podium?: Record<string, unknown>;
        classified_minimum?: Record<string, unknown>;
        race_overrides?: {
          subsession_ids?: unknown[];
          base_points?: Record<string, unknown>;
          classified_minimum?: Record<string, unknown>;
        };
      }
    | null
    | undefined;
  if (!r || typeof r !== 'object')
    return { finishPoints: null, classPoints: null, classifiedMinimumFinishPoints: null };

  const overrideActive =
    Array.isArray(r.race_overrides?.subsession_ids) &&
    r.race_overrides!.subsession_ids!.some((sid) => String(sid) === String(subsessionId));

  const finishPoints =
    (overrideActive ? toNumberArray(r.race_overrides?.base_points?.[String(raceNumber)]) : null) ??
    (format === 'sprint' && raceNumber === 3 ? toNumberArray(r.base_points?.sprint_race3) : null) ??
    (format === 'sprint' && raceNumber > 1 ? toNumberArray(r.base_points?.sprint_race2) : null) ??
    toNumberArray(r.base_points?.[format]);

  const classPoints =
    (format === 'sprint' && raceNumber === 3 ? toNumberArray(r.class_podium?.sprint_race3) : null) ??
    (format === 'sprint' && raceNumber > 1 ? toNumberArray(r.class_podium?.sprint_race2) : null) ??
    toNumberArray(r.class_podium?.[format]);

  const classifiedMinimumFinishPoints =
    (overrideActive ? toFiniteNumber(r.race_overrides?.classified_minimum?.[String(raceNumber)]) : null) ??
    toFiniteNumber(r.classified_minimum?.[format]);

  return { finishPoints, classPoints, classifiedMinimumFinishPoints };
}

/** Ruleset-aware finish points for a position — prices off `tables.finishPoints` when the ruleset resolved one, falling back to the fixed FINISH_POINTS table (finishPointsForPosition) otherwise, same as every call site behaved before this existed. */
export function finishPointsFromTables(format: Format, position: number, tables: RacePointsTables): number {
  if (tables.finishPoints) {
    if (position >= 1 && position <= tables.finishPoints.length) return tables.finishPoints[position - 1];
    if (tables.classifiedMinimumFinishPoints !== null) return tables.classifiedMinimumFinishPoints;
  }
  return finishPointsForPosition(format, position);
}

/** Ruleset-aware class-podium points — same fallback story as finishPointsFromTables. */
export function classPointsFromTables(
  format: Format,
  classPosition: number | null,
  awardsClassPoints: boolean,
  tables: RacePointsTables,
): number {
  if (!awardsClassPoints) return 0;
  if (tables.classPoints) {
    if (classPosition === null || classPosition < 1 || classPosition > tables.classPoints.length) return 0;
    return tables.classPoints[classPosition - 1];
  }
  return classPointsForPosition(format, classPosition, awardsClassPoints);
}
