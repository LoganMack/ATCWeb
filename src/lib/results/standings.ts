import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getScoringRulesets, resolveSeasonRuleset, type Season, type ScoringRuleset } from '../db/seasons';
import { getDriverClasses, type Lookup } from '../db/lookups';
import { computeSeasonClassAdjustments, type SeasonClassScoreRow } from '../penalties/seasonAdjustments';
import { isChampionshipSeason } from './shared';
import {
  getRaceScoresForSeasonClass,
  driversSelect,
  resultKey,
  type DriverBasic,
  type RaceScoreRow,
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
  /** Same sharing reasoning as `precomputedOverallContext` — lets a caller that already fetched this class's own race_scores rows (e.g. computeTeamSeasonStandings' per-class team competition, which needs the identical rows) pass them in instead of querying twice. */
  precomputedScoresRaw?: RaceScoreRow[],
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

  // Cross-class penalty context — this class's finish points are based on
  // OVERALL field position, which a penalty against a driver in a DIFFERENT
  // class in the same race can also shift, so this class's own (filtered)
  // `scores` alone isn't enough to know that. See getSeasonOverallContext.
  const overallContext =
    precomputedOverallContext ??
    (await getSeasonOverallContext(env, season, exhibitionIds, drivers, allRulesets));
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
  /** race_scores_public rows for this season and class, before excluded rounds are removed. */
  scoresRaw: RaceScoreRow[];
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
  // Alpha's own scoring never includes the top-3-in-class Class Points
  // bonus (that's Gamma/Delta's own per-race class-position bonus, see
  // README) — used below so a penalty-driven class-position change can
  // never manufacture Class Points for an Alpha driver.
  const awardsClassPoints = classes.find((c) => c.id === classId)?.name !== 'Alpha';
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

  // The context's own `rawByKey` already covers every subsession this whole
  // SEASON raced (a superset of this one class's own subsessions), so it
  // doubles as this class's curated_race_results lookup too — no separate
  // fetch needed for that anymore.
  const rawByKey = overallContext.rawByKey;

  // Group this class's race_scores rows by (subsession_id, race_number) so
  // each individual race can be ranked within the class.
  const raceGroups = new Map<string, RaceScoreRow[]>();
  for (const s of scores) {
    const key = `${s.subsession_id}:${s.race_number}`;
    if (!raceGroups.has(key)) raceGroups.set(key, []);
    raceGroups.get(key)!.push(s);
  }

  const accum = new Map<string, StandingsAccum>();
  function getAccum(driverId: string): StandingsAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = newStandingsAccum();
      accum.set(driverId, a);
    }
    return a;
  }

  // Class-relative rank per race, using the raw imported position — same
  // derivation as before, but captured per (subsession,race,driver) so the
  // penalty engine has an "original class position" baseline to compare
  // against, whether or not this particular race actually has a penalty.
  const classScoreRows: SeasonClassScoreRow[] = [];
  const originalClassPositionByKey = new Map<string, number>();
  for (const [raceKey, group] of raceGroups) {
    const ranked = group
      .filter((s) => !s.dsq)
      .map((s) => {
        const custId = custIdByDriverId.get(s.driver_id);
        const raw =
          custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
        const lapStatsRow =
          custId != null
            ? overallContext.lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId))
            : undefined;
        return {
          score: s,
          position: raw?.adjusted_position ?? raw?.finish_position ?? null,
          interval: raw?.interval_ten_thousandths ?? null,
          lapsComplete: raw?.laps_complete ?? null,
          averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
        };
      })
      .filter((r) => r.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number));

    ranked.forEach((r, i) => {
      const classPosition = i + 1;
      const key = `${raceKey}:${r.score.driver_id}`;
      originalClassPositionByKey.set(key, classPosition);
      classScoreRows.push({
        subsessionId: r.score.subsession_id,
        raceNumber: r.score.race_number,
        driverId: r.score.driver_id,
        dsq: r.score.dsq,
        classified: r.score.classified,
        classPosition,
        intervalTenThousandths: r.interval,
        totalPoints: r.score.total_points,
        classPoints: r.score.class_points,
        finesseBonus: r.score.finesse_bonus,
        poleBonus: r.score.pole_bonus,
        aggressionBonus: r.score.aggression_bonus,
        lapLedBonus: r.score.lap_led_bonus,
        fewestIncidentsBonus: r.score.fewest_incidents_bonus,
        fastestLapBonus: r.score.fastest_lap_bonus,
        sprintSweepBonus: r.score.sprint_sweep_bonus,
        pointsDeduction: r.score.points_deduction,
        lapsComplete: r.lapsComplete,
        averageLapTenThousandths: r.averageLapTenThousandths,
      });
    });
  }

  const classAdjustments = computeSeasonClassAdjustments(
    classScoreRows,
    overallContext.penalties,
    overallContext.formatBySubsession,
    overallContext.adjustments,
    overallContext.leaderStatsByRace,
    awardsClassPoints,
    overallContext.rulesBySubsession,
  );

  // Disqualified results are excluded from ranking entirely (not just
  // demoted to last) so a DSQ'd driver can never be credited with a
  // win/podium/top 5/top 10, and everyone behind them ranks up normally —
  // they still count toward that driver's own starts/appearances/points
  // below, just not toward anyone's class position. Uses the
  // penalty-adjusted class rank when this race actually had one logged,
  // otherwise the original rank exactly as before.
  for (const [raceKey, group] of raceGroups) {
    for (const s of group) {
      if (s.dsq) continue;
      const key = `${raceKey}:${s.driver_id}`;
      const adjustment = classAdjustments.get(key);
      const classRank = adjustment
        ? adjustment.newClassPosition
        : (originalClassPositionByKey.get(key) ?? null);
      if (classRank === null) continue;
      const a = getAccum(s.driver_id);
      const rs = roundStatFor(a, s.subsession_id);
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
  }

  // Alpha never earns its own "Class Pole" bonus (pole_bonus is
  // structurally always 0 for Alpha — see README/computeOverallSeasonStandings'
  // doc comment), so its "poles" stat — displayed and used as a tiebreaker —
  // falls back to the true overall pole-sitter instead, same as the Overall
  // view. Gamma/Delta keep using their own real Class Pole (pole_bonus).
  const isAlphaClass = !awardsClassPoints;
  const overallPoleDriverBySubsession = isAlphaClass
    ? computeOverallPoleDriverBySubsession(overallContext)
    : null;

  // Alpha's points MUST come from the exact same source computeOverallSeasonStandings
  // uses (finish_points + finesse_bonus + pole_bonus + points_deduction, with
  // overallContext's OWN cross-class penalty adjustment applied) rather than
  // this class's own classAdjustments/raw total_points — see the bug this
  // fixes: `computeSeasonClassAdjustments` above only reprocesses a race when
  // one of THIS class's own drivers was directly penalized
  // (`computeSeasonClassAdjustments`'s `touched` check). A penalty against a
  // driver in a DIFFERENT class can still shift an Alpha driver's OVERALL
  // cross-class position (and therefore their position-based finish_points)
  // without touching anything Alpha-relative at all — `computeSeasonOverallAdjustments`
  // correctly catches that ripple (its own `touched` check is keyed off ANY
  // driver in the race, any class), but the class-scoped pass above never
  // sees it, so Alpha's per-class points silently stayed stuck at the
  // pre-penalty (too-low, once the ripple should have moved them UP) value.
  // Since Alpha never earns class_points, "Alpha standings" isn't really a
  // separate competition from "Overall" at all — it's Overall's own formula,
  // just reported per-class — so sourcing points from `overallContext`
  // directly instead of re-deriving them class-locally is both the fix and
  // the more honest model of what this table actually is.
  const overallPointsByKey = isAlphaClass
    ? new Map(
        overallContext.overallScores
          .filter((s) => s.class_id === classId)
          .map((s) => {
            const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
            const adjustment = overallContext.adjustments.get(key);
            const points = adjustment
              ? adjustment.overallTotalPoints
              : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
            return [key, points] as const;
          }),
      )
    : null;

  // Starts, appearances, poles, and points come straight from race_scores
  // regardless of whether a matching curated_race_results row was found —
  // except total_points, which uses the penalty-adjusted figure whenever
  // this race actually has one logged.
  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    const rs = roundStatFor(a, s.subsession_id);
    rs.starts += 1;
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
    const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
    let totalPoints: number;
    if (isAlphaClass) {
      // Falls back to this class's own raw total_points only if this row is
      // somehow missing from overallContext.overallScores (shouldn't happen
      // — that fetch covers every class every one of this class's rows also
      // appears in — but never worse than the pre-fix behavior if it did).
      totalPoints = overallPointsByKey!.get(key) ?? s.total_points;
    } else {
      const adjustment = classAdjustments.get(key);
      totalPoints = adjustment ? adjustment.totalPoints : s.total_points;
    }
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + totalPoints);
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
 * `race_scores.pole_bonus` (each class's own "Class Pole" — fastest
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
 * Every class combined into one table, ranked by the same points formula
 * Alpha already effectively uses — `finish_points + finesse_bonus +
 * pole_bonus + points_deduction` — deliberately excluding `class_points`
 * (Logan: "class points for gammas and deltas are not counted... it should
 * essentially be the alpha standings with everyone included"). `class_points`
 * is Delta/Gamma's own per-race class-position bonus; Alpha never has one,
 * so counting it here would make Alpha drivers structurally unable to
 * compete for the same overall total.
 *
 * Wins/podiums/top 5s/top 10s come straight from `race_scores.scored_position`
 * (the overall field position across every class) rather than the per-class
 * re-derivation `computeSeasonStandings` does — same approach the race
 * results page's "Overall" view uses.
 *
 * Poles are the exception: `race_scores.pole_bonus` is actually Gamma/Delta's
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
    precomputedOverallContext ??
    (await getSeasonOverallContext(env, season, exhibitionIds, drivers, allRulesets));
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

    const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
    const adjustment = overallContext.adjustments.get(key);
    const points = adjustment
      ? adjustment.overallTotalPoints
      : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + points);

    const position = adjustment ? adjustment.newPosition : s.scored_position;
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
