import type { SupabaseEnv } from '../db/client';
import {
  getSeasons,
  getScoringRulesets,
  resolveSeasonRuleset,
  type Season,
  type ScoringRuleset,
} from '../db/seasons';
import { getPenaltiesForSubsessions, type Penalty } from '../db/penalties';
import {
  computeSeasonOverallAdjustments,
  type SeasonOverallAdjustment,
  type SeasonScoreRow,
} from '../penalties/seasonAdjustments';
import type { LeaderRaceStats } from '../penalties/reorder';
import type { Format } from '../penalties/points';
import {
  getRaceScoresForSeasonOverall,
  getCuratedRaceResultsForSubsessions,
  getLapStatsForSubsessions,
  resultKey,
  type CuratedRaceResultRow,
  type RaceScoreOverallRow,
  type RawLapStatsRow,
  type RoundSummary,
  type DriverBasic,
} from './rows';
import { getRoundsForSeason } from './rounds';

// ---------------------------------------------------------------------------
// Season-wide penalty context — shared plumbing behind computeSeasonStandings
// and computeOverallSeasonStandings so a penalty logged on the results page
// (src/pages/results/[subsessionId].astro) also ripples into both standings
// views, not just that one round's own page. See src/lib/penalties.ts's
// computeSeasonOverallAdjustments/computeSeasonClassAdjustments for the
// actual recompute math — this just fetches what those need.
// ---------------------------------------------------------------------------

export interface CurrentSeasonRounds {
  season: Season | null;
  subsessionIds: number[];
  formatBySubsession: Map<number, Format | null>;
}

/**
 * The site's one `is_current` season's round subsession_ids — this is what
 * "this season" means for PP/warning scoping (rule 57's season PP limit),
 * as opposed to the arbitrary season a standings/champions page might be
 * showing. Returns an empty result (no rounds) if no season is currently
 * flagged current.
 */
export async function getCurrentSeasonRounds(env: SupabaseEnv): Promise<CurrentSeasonRounds> {
  const seasons = await getSeasons(env);
  const season = seasons.find((s) => s.is_current) ?? null;
  if (!season) return { season: null, subsessionIds: [], formatBySubsession: new Map() };
  const rounds = await getRoundsForSeason(env, season.id);
  return {
    season,
    subsessionIds: rounds.map((r) => r.subsession_id),
    formatBySubsession: new Map(rounds.map((r) => [r.subsession_id, r.format])),
  };
}

export interface SeasonOverallContext {
  /** (subsessionId:raceNumber:driverId) -> adjustment, only for races a penalty actually touched. */
  adjustments: Map<string, SeasonOverallAdjustment>;
  penalties: Penalty[];
  formatBySubsession: Map<number, Format | null>;
  /** This season's resolved scoring_rulesets.rules, repeated for every one of this season's own subsession_ids — same Map-by-subsession shape as formatBySubsession purely so computeSeasonOverallAdjustments/computeSeasonClassAdjustments (which also serve getDriverRaceHistory's real multi-season, multi-ruleset call) can use one consistent lookup. Every context built here is always single-season, so every value in this map is identical. See src/lib/penalties.ts's resolvePointsTables for why this needs to be the season's own ruleset rather than the fixed FINISH_POINTS/CLASS_POINTS tables. */
  rulesBySubsession: Map<number, unknown>;
  rawByKey: Map<string, CuratedRaceResultRow>;
  overallScores: RaceScoreOverallRow[];
  custIdByDriverId: Map<string, number>;
  /** (subsessionId:raceNumber) -> that race's actual leader's own laps/average-lap — see src/lib/penalties.ts's computeSeasonClassAdjustments, which needs this since its own rows are already filtered to one class and may not contain the (possibly different-class) overall leader. */
  leaderStatsByRace: Map<string, LeaderRaceStats>;
  /** (subsessionId:raceNumber:custId) -> that result's average/best lap data — exposed so computeSeasonStandings can attach lapsComplete/averageLapTenThousandths onto its per-class rows (rule 18.3.2's estimated-overall-race-time path) without re-querying. */
  lapStatsByKey: Map<string, RawLapStatsRow>;
  /** This season's own `curated_rounds` rows (the same fetch `formatBySubsession` is derived from) — exposed so a caller that also needs another field off these rows (e.g. `getSeasonDriverExtendedStats`' track_name lookup for distance/corners) can reuse this instead of re-querying `curated_rounds` a second time for the same season. */
  seasonRounds: RoundSummary[];
}

/**
 * Fetches everything needed to know how this season's penalties affect
 * OVERALL (cross-class) field position and finish points. Shared by
 * computeSeasonStandings (which additionally layers its own class-relative
 * class_points recompute on top — a class's finish points still depend on
 * the OVERALL position, which a penalty against a driver in a *different*
 * class in the same race can also shift) and computeOverallSeasonStandings
 * (which uses this directly, since the overall view never awards
 * class_points) — kept as one function so the two views can never derive a
 * different overall position/finish-points number for the same driver in
 * the same race.
 *
 * A thin fetch-then-build wrapper around `buildSeasonOverallContext` below —
 * every single-season caller (Standings, Team Standings, Champions, Race
 * Results) goes through this one-season-at-a-time fetch. `computeDriverCareerStats`,
 * which needs this same context for MANY seasons at once, instead
 * bulk-fetches the same 4 raw ingredients ONCE across every season and
 * calls `buildSeasonOverallContext` directly per season on its own
 * in-memory slice, with no network calls in that loop. Splitting this
 * function is what lets that happen without duplicating the adjustment math
 * below.
 *
 * Exported so any caller that needs MULTIPLE standings views for the same
 * season — e.g. the homepage's Overall/Alpha/Gamma/Delta/Rookies standings
 * widget — can build this once and pass it as `precomputedOverallContext`
 * to each of computeSeasonStandings/computeOverallSeasonStandings, instead
 * of each view re-fetching its own copy.
 */
export async function getSeasonOverallContext(
  env: SupabaseEnv,
  season: Season,
  exhibitionIds: Set<number>,
  drivers: DriverBasic[],
  /** Pass every ruleset on file when a caller already has them (e.g. computeSeasonStandings/computeOverallSeasonStandings, which resolve their own `canDropFinalRound` from the same fetch) so this doesn't refetch the same small table a second time. Resolved against this `season` via `resolveSeasonRuleset` either way. */
  rulesets?: ScoringRuleset[],
): Promise<SeasonOverallContext> {
  const [overallScoresRaw, allRulesets] = await Promise.all([
    getRaceScoresForSeasonOverall(env, season.id),
    rulesets ? Promise.resolve(rulesets) : getScoringRulesets(env),
  ]);
  const rules = resolveSeasonRuleset(season, allRulesets)?.rules ?? null;
  // Same exhibition-filtered scope the original single fetch-and-build
  // version used for its subsessionIds — buildSeasonOverallContext below
  // re-derives this same filtered set itself (cheap, in-memory), so this
  // is just to keep this wrapper's OWN fetches scoped to exactly the same
  // rounds as before, not a behavior change.
  const filteredForFetchScope =
    exhibitionIds.size > 0
      ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id))
      : overallScoresRaw;
  const subsessionIds = [...new Set(filteredForFetchScope.map((s) => s.subsession_id))];
  const [rawResults, penalties, seasonRounds, lapStats] = await Promise.all([
    getCuratedRaceResultsForSubsessions(env, subsessionIds),
    getPenaltiesForSubsessions(env, subsessionIds),
    getRoundsForSeason(env, season.id),
    getLapStatsForSubsessions(env, subsessionIds),
  ]);

  return buildSeasonOverallContext(
    exhibitionIds,
    drivers,
    overallScoresRaw,
    rawResults,
    penalties,
    seasonRounds,
    lapStats,
    rules,
  );
}

/**
 * Pure (no network) half of `getSeasonOverallContext` — everything from
 * that function's body that isn't itself a fetch, taking the same 4 raw
 * ingredients (this season's race_scores, curated_race_results, penalties,
 * curated_rounds, plus average/best lap data) as plain arrays instead of
 * fetching them. `getSeasonOverallContext` calls this immediately after its
 * own one-season fetch; `computeDriverCareerStats` calls this directly,
 * once per season, on slices of ONE bulk multi-season fetch instead —
 * see that function's own doc comment for why.
 */
export function buildSeasonOverallContext(
  exhibitionIds: Set<number>,
  drivers: DriverBasic[],
  overallScoresRaw: RaceScoreOverallRow[],
  rawResults: CuratedRaceResultRow[],
  penalties: Penalty[],
  seasonRounds: RoundSummary[],
  lapStats: RawLapStatsRow[],
  /** This season's resolved scoring_rulesets.rules (or null if none resolves) — every caller of this function is single-season-scoped, so this one value is repeated across every subsession_id below to build rulesBySubsession. See SeasonOverallContext.rulesBySubsession's own doc comment. */
  rules: unknown,
): SeasonOverallContext {
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );

  const overallScores =
    exhibitionIds.size > 0
      ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id))
      : overallScoresRaw;

  if (overallScores.length === 0) {
    return {
      adjustments: new Map(),
      penalties: [],
      formatBySubsession: new Map(),
      rulesBySubsession: new Map(),
      rawByKey: new Map(),
      overallScores: [],
      custIdByDriverId,
      leaderStatsByRace: new Map(),
      lapStatsByKey: new Map(),
      seasonRounds: [],
    };
  }

  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const lapStatsByKey = new Map(
    lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]),
  );
  const formatBySubsession = new Map(seasonRounds.map((r) => [r.subsession_id, r.format]));
  const rulesBySubsession = new Map(seasonRounds.map((r) => [r.subsession_id, rules]));

  // This season's race leaders (rule 18.3.2's reference point — see
  // src/lib/penalties.ts's Position recalculation header) — every touched
  // race's own actual on-track winner, pre-penalty, keyed the same way
  // computeSeasonClassAdjustments looks it up.
  const leaderStatsByRace = new Map<string, LeaderRaceStats>();
  for (const r of rawResults) {
    if (r.finish_position === 1) {
      leaderStatsByRace.set(`${r.subsession_id}:${r.race_number}`, {
        lapsComplete: r.laps_complete,
        averageLapTenThousandths:
          lapStatsByKey.get(resultKey(r.subsession_id, r.race_number, r.cust_id))
            ?.average_lap_ten_thousandths ?? null,
      });
    }
  }

  if (penalties.length === 0) {
    return {
      adjustments: new Map(),
      penalties,
      formatBySubsession,
      rulesBySubsession,
      rawByKey,
      overallScores,
      custIdByDriverId,
      leaderStatsByRace,
      lapStatsByKey,
      seasonRounds,
    };
  }

  const seasonScoreRows: SeasonScoreRow[] = overallScores.map((s) => {
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    const lapStatsRow =
      custId != null ? lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    return {
      subsessionId: s.subsession_id,
      raceNumber: s.race_number,
      driverId: s.driver_id,
      dsq: s.dsq,
      classified: s.classified,
      scoredPosition: s.scored_position,
      intervalTenThousandths: raw?.interval_ten_thousandths ?? null,
      finishPoints: s.finish_points,
      finesseBonus: s.finesse_bonus,
      poleBonus: s.pole_bonus,
      aggressionBonus: s.aggression_bonus,
      pointsDeduction: s.points_deduction,
      lapsComplete: raw?.laps_complete ?? null,
      averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
    };
  });

  const adjustments = computeSeasonOverallAdjustments(
    seasonScoreRows,
    penalties,
    formatBySubsession,
    rulesBySubsession,
  );
  return {
    adjustments,
    penalties,
    formatBySubsession,
    rulesBySubsession,
    rawByKey,
    overallScores,
    custIdByDriverId,
    leaderStatsByRace,
    lapStatsByKey,
    seasonRounds,
  };
}
