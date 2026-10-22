import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getScoringRulesets, resolveSeasonRuleset, type Season, type ScoringRuleset } from '../db/seasons';
import { getDriverClasses, type Lookup } from '../db/lookups';
import { isChampionshipSeason } from './shared';
import {
  getRaceScoresForSeasonClass,
  driversSelect,
  rankedByClassTotal,
  resultKey,
  seasonPointsOf,
  type DriverBasic,
  type ScoreRow,
} from './rows';
import { getSeasonOverallContext, type SeasonOverallContext } from './seasonContext';
import {
  newStandingsAccum,
  roundStatFor,
  findFinalRoundSubsessionId,
  finalizeStandings,
  rulesetBaseDropWeeks,
  buildPenaltiesByDriverAndRound,
  type DriverSeasonStanding,
  type StandingsAccum,
} from './standingsCore';

/**
 * Computes the full standings for one season+class, sorted by points
 * (ties broken by wins, then podiums). Pass a pre-fetched `driversBasic`
 * list (and `exhibitionRoundIds`, `classesLookup`) when computing many
 * seasons back to back (see `getChampions`) to avoid re-fetching the same
 * data every time.
 *
 * Returns an empty list for a non-championship (exhibition) season without
 * querying anything else — see `isChampionshipSeason`.
 */
export async function computeSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  classId: number,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>,
  classesLookup?: Lookup[],
  /**
   * A season-wide penalty context computed elsewhere and passed in so this
   * call doesn't re-fetch it — see `getSeasonOverallContext`'s own doc
   * comment. `computeDriverCareerStats` is the reason this exists: it needs
   * this same season's standings for every class plus the overall/team/
   * extended-stats views, and without sharing this one (expensive, ~5
   * query) fetch across all of them, a career-wide computation across many
   * seasons blows straight through Cloudflare Workers' per-request
   * subrequest limit. Every other caller just omits this and gets the
   * original one-context-per-call behavior.
   */
  precomputedOverallContext?: SeasonOverallContext,
  /** Same sharing reasoning as `precomputedOverallContext` — lets a caller that already fetched this class's own race_score_results rows (e.g. computeTeamSeasonStandings' per-class team competition, which needs the identical rows) pass them in instead of querying twice. */
  precomputedScoresRaw?: ScoreRow[],
  /** Same sharing reasoning as `driversBasic` above — pass every ruleset on file when computing many seasons back to back (see `getChampions`/`computeDriverCareerStats`) so this doesn't refetch the same small table once per season. Resolved against this `season` via `resolveSeasonRuleset` either way. */
  rulesets?: ScoringRuleset[],
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [scoresRaw, drivers, exhibitionIds, classes, allRulesets] = await Promise.all([
    precomputedScoresRaw
      ? Promise.resolve(precomputedScoresRaw)
      : getRaceScoresForSeasonClass(env, season.id, classId),
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    classesLookup ? Promise.resolve(classesLookup) : getDriverClasses(env),
    rulesets ? Promise.resolve(rulesets) : getScoringRulesets(env),
  ]);
  // The exclusion filter and empty check run here, before the context fetch,
  // so an empty class costs no context fetch. buildSeasonStandings repeats
  // them so it is correct on its own.
  const scores =
    exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
  if (scores.length === 0) return [];

  // Raw results, lap stats and the true overall pole come from the season-wide context.
  const overallContext =
    precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  return buildSeasonStandings({
    season,
    classId,
    scoresRaw,
    drivers,
    exhibitionIds,
    classes,
    rulesets: allRulesets,
    overallContext,
  });
}

/** Everything `buildSeasonStandings` needs, already fetched. */
export interface ClassStandingsInputs {
  season: Season;
  classId: number;
  /** race_score_results_public rows for this season and class, before excluded rounds are removed. */
  scoresRaw: ScoreRow[];
  drivers: DriverBasic[];
  /** Standings-excluded rounds (exhibition or test). */
  exhibitionIds: Set<number>;
  classes: Lookup[];
  rulesets: ScoringRuleset[];
  overallContext: SeasonOverallContext;
}

/**
 * Pure (no network) body of `computeSeasonStandings`: one season and class's
 * standings from rows already fetched. Kept separate so tests can run it on
 * plain arrays.
 */
export function buildSeasonStandings({
  season,
  classId,
  scoresRaw,
  drivers,
  exhibitionIds,
  classes,
  rulesets: allRulesets,
  overallContext,
}: ClassStandingsInputs): DriverSeasonStanding[] {
  // Defaults to protected (canDropFinalRound=false) when no ruleset resolves
  // at all — see ScoringRuleset.can_drop_final_round's own doc comment.
  const canDropFinalRound = resolveSeasonRuleset(season, allRulesets)?.can_drop_final_round ?? false;
  const className = classes.find((c) => c.id === classId)?.name;
  // Gamma and Delta rank on class_total, Alpha on overall_total (BR2.6).
  const classTotal = rankedByClassTotal(className);
  // Individual rounds can be flagged exhibition even inside a real
  // championship season (e.g. a pre-season race) — those never count
  // toward standings, same as a whole exhibition season.
  const scores =
    exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );
  const rawByKey = overallContext.rawByKey;

  const accum = new Map<string, StandingsAccum>();
  function getAccum(driverId: string): StandingsAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = newStandingsAccum();
      accum.set(driverId, a);
    }
    return a;
  }

  // Alpha never earns its own "Class Pole" bonus (pole_bonus is always 0 for
  // Alpha), so its "poles" stat, shown and used as a tiebreaker, counts the
  // true overall pole-sitter instead, as the Overall view does. Gamma/Delta
  // count their own Class Pole (pole_bonus).
  const isAlphaClass = className === 'Alpha';
  const overallPoleDriverBySubsession = isAlphaClass
    ? computeOverallPoleDriverBySubsession(overallContext)
    : null;

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    const rs = roundStatFor(a, s.subsession_id);
    rs.starts += 1;
    // Wins/podiums/top 5s/top 10s rank within the class; a DSQ has no class
    // position, so it never counts and everyone behind moves up.
    const classRank = s.dsq ? null : s.class_position;
    if (classRank !== null) {
      if (classRank === 1) {
        a.wins++;
        rs.wins++;
      }
      if (classRank <= 3) {
        a.podiums++;
        rs.podiums++;
      }
      if (classRank <= 5) {
        a.top5s++;
        rs.top5s++;
      }
      if (classRank <= 10) {
        a.top10s++;
        rs.top10s++;
      }
    }
    if (isAlphaClass) {
      if (overallPoleDriverBySubsession!.get(s.subsession_id) === s.driver_id)
        a.poleSubsessionIds.add(s.subsession_id);
    } else if (s.pole_bonus > 0) {
      a.poleSubsessionIds.add(s.subsession_id);
    }
    rs.poles = a.poleSubsessionIds.has(s.subsession_id) ? 1 : 0;
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    a.lapsLed += raw?.laps_led ?? 0;
    a.laps += raw?.laps_complete ?? 0;
    rs.lapsLed += raw?.laps_led ?? 0;
    rs.laps += raw?.laps_complete ?? 0;
    a.roundPoints.set(
      s.subsession_id,
      (a.roundPoints.get(s.subsession_id) ?? 0) + seasonPointsOf(s, classTotal),
    );
  }

  // Every round this class actually raced this season (already
  // exhibition-filtered, same as `scores`) — see finalizeStandings' own doc
  // comment on why a driver's missed rounds need to be in this pool too.
  const allSubsessionIds = new Set(scores.map((s) => s.subsession_id));
  const finalRoundSubsessionId = findFinalRoundSubsessionId(overallContext.seasonRounds, exhibitionIds);
  return finalizeStandings(
    accum,
    driverById,
    season,
    allSubsessionIds,
    finalRoundSubsessionId,
    canDropFinalRound,
    rulesetBaseDropWeeks(resolveSeasonRuleset(season, allRulesets)),
    buildPenaltiesByDriverAndRound(overallContext.penalties),
  );
}

/**
 * subsessionId -> the driver who actually had grid position 1 on that
 * round's race 1 — the TRUE overall pole-sitter, as opposed to
 * `pole_bonus` (each class's own "Class Pole" — fastest
 * qualifier within just that driver's own class; see
 * `computeOverallSeasonStandings`' own doc comment for why that's not the
 * same thing). Shared by `computeOverallSeasonStandings` (which always needs
 * the true overall pole) and `computeSeasonStandings` — but only for the
 * Alpha class, which never earns its own "Class Pole" bonus (Alpha doesn't
 * get class_points/pole_bonus at all — see README), so Alpha's own
 * `pole_bonus` count is structurally always 0 and can't stand in as a real
 * "poles" stat or tiebreaker column the way it can for Gamma/Delta.
 */
function computeOverallPoleDriverBySubsession(context: SeasonOverallContext): Map<number, string> {
  const custIdToDriverId = new Map(
    [...context.custIdByDriverId].map(([driverId, custId]) => [custId, driverId]),
  );
  const overallPoleDriverBySubsession = new Map<number, string>();
  for (const raw of context.rawByKey.values()) {
    if (raw.race_number === 1 && raw.starting_position === 1) {
      const driverId = custIdToDriverId.get(raw.cust_id);
      if (driverId) overallPoleDriverBySubsession.set(raw.subsession_id, driverId);
    }
  }
  return overallPoleDriverBySubsession;
}

/**
 * Every class combined into one table, ranked by `overall_total` — every
 * bonus less the deduction, deliberately excluding `class_points` (Logan:
 * "class points for gammas and deltas are not counted... it should
 * essentially be the alpha standings with everyone included"). `class_points`
 * is Delta/Gamma's own per-race class-position bonus; Alpha never has one,
 * so counting it here would make Alpha drivers structurally unable to
 * compete for the same overall total.
 *
 * Wins/podiums/top 5s/top 10s come from the overall position across every
 * class, as the race results page's "Overall" view shows it.
 *
 * Poles are the exception: `pole_bonus` is actually Gamma/Delta's
 * "Class Pole" (fastest qualifier within just that driver's class), so using
 * it here would credit a driver for merely out-qualifying their own class,
 * not the whole grid. Instead this view derives the real overall pole-sitter
 * from `curated_race_results.starting_position` on each round's race 1 — the
 * only race with real qualifying, since 2/3 invert off it.
 */
export async function computeOverallSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>,
  /** See `computeSeasonStandings`' identical param — shares one season-wide penalty context across every view instead of each fetching its own. */
  precomputedOverallContext?: SeasonOverallContext,
  /** See `computeSeasonStandings`' identical param. */
  rulesets?: ScoringRuleset[],
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [drivers, exhibitionIds, allRulesets] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    rulesets ? Promise.resolve(rulesets) : getScoringRulesets(env),
  ]);

  const overallContext =
    precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  return buildOverallSeasonStandings({
    season,
    drivers,
    exhibitionIds,
    rulesets: allRulesets,
    overallContext,
  });
}

/** Everything `buildOverallSeasonStandings` needs, already fetched. */
export interface OverallStandingsInputs {
  season: Season;
  drivers: DriverBasic[];
  /** Standings-excluded rounds (exhibition or test). */
  exhibitionIds: Set<number>;
  rulesets: ScoringRuleset[];
  overallContext: SeasonOverallContext;
}

/**
 * Pure (no network) body of `computeOverallSeasonStandings`: every class
 * combined, from rows already fetched. Kept separate so tests can run it on
 * plain arrays.
 */
export function buildOverallSeasonStandings({
  season,
  drivers,
  exhibitionIds,
  rulesets: allRulesets,
  overallContext,
}: OverallStandingsInputs): DriverSeasonStanding[] {
  const canDropFinalRound = resolveSeasonRuleset(season, allRulesets)?.can_drop_final_round ?? false;

  const scores = overallContext.overallScores;
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const accum = new Map<string, StandingsAccum>();
  function getAccum(driverId: string): StandingsAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = newStandingsAccum();
      accum.set(driverId, a);
    }
    return a;
  }

  const overallPoleDriverBySubsession = computeOverallPoleDriverBySubsession(overallContext);

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.classId = s.class_id;
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    const rs = roundStatFor(a, s.subsession_id);
    rs.starts += 1;
    if (overallPoleDriverBySubsession.get(s.subsession_id) === s.driver_id)
      a.poleSubsessionIds.add(s.subsession_id);
    rs.poles = a.poleSubsessionIds.has(s.subsession_id) ? 1 : 0;

    const custId = overallContext.custIdByDriverId.get(s.driver_id);
    const raw =
      custId != null
        ? overallContext.rawByKey.get(resultKey(s.subsession_id, s.race_number, custId))
        : undefined;
    a.lapsLed += raw?.laps_led ?? 0;
    a.laps += raw?.laps_complete ?? 0;
    rs.lapsLed += raw?.laps_led ?? 0;
    rs.laps += raw?.laps_complete ?? 0;

    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + s.overall_total);

    const position = s.position;
    if (!s.dsq && position !== null) {
      if (position === 1) {
        a.wins++;
        rs.wins++;
      }
      if (position <= 3) {
        a.podiums++;
        rs.podiums++;
      }
      if (position <= 5) {
        a.top5s++;
        rs.top5s++;
      }
      if (position <= 10) {
        a.top10s++;
        rs.top10s++;
      }
    }
  }

  // Every round the season actually had, across every class (already
  // exhibition-filtered, same as `scores`) — see finalizeStandings' own doc
  // comment on why a driver's missed rounds need to be in this pool too.
  const allSubsessionIds = new Set(scores.map((s) => s.subsession_id));
  const finalRoundSubsessionId = findFinalRoundSubsessionId(overallContext.seasonRounds, exhibitionIds);
  return finalizeStandings(
    accum,
    driverById,
    season,
    allSubsessionIds,
    finalRoundSubsessionId,
    canDropFinalRound,
    rulesetBaseDropWeeks(resolveSeasonRuleset(season, allRulesets)),
    buildPenaltiesByDriverAndRound(overallContext.penalties),
  );
}
