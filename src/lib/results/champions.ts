import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos } from '../db/assets';
import { getScoringRulesets, resolveSeasonRuleset, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions } from '../db/penalties';
import { getDriverClasses } from '../db/lookups';
import { isDecidedChampionshipSeason } from './shared';
import { driversSelect, getRaceScoresForSeasonsBulk, getTeamsBasic, getAllTeamSeasonLogosSafe } from './rows';
import { buildSeasonOverallContext } from './seasonContext';
import type { DriverSeasonStanding } from './standingsCore';
import { computeSeasonStandings } from './standings';
import { computeTeamSeasonStandings, type TeamSeasonStanding } from './teamStandings';
import { getCuratedRaceResultsWithLapStatsBulk } from './extendedStats';
import { getSeasonCarTeamStats, type DriverSeasonExtras } from './seasonCarTeam';
import { getAllRounds } from './rounds';

// ---------------------------------------------------------------------------
// Champions — the #1 standing for every season a class actually raced in
// ---------------------------------------------------------------------------

export interface ChampionEntry {
  season: Season;
  standing: DriverSeasonStanding;
}

/**
 * One entry per season the given class has any race_scores data for,
 * newest season first. Seasons before a class existed (Delta before ATC5,
 * Gamma before ATC16) simply have no rows and are skipped automatically —
 * no hardcoded season cutoffs needed.
 */
export async function getChampions(
  env: SupabaseEnv,
  seasons: Season[],
  classId: number,
): Promise<ChampionEntry[]> {
  // isDecidedChampionshipSeason, not isChampionshipSeason alone — a season
  // still flagged is_current has no champion to show yet, per Logan.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  // Same "bulk-fetch once across every season, then slice in memory" fix
  // computeDriverCareerStats needed for the exact same reason (see that
  // function's own doc comment) — this used to call computeSeasonStandings
  // once per season with nothing precomputed, so each of computeSeasonStandings'
  // own several queries multiplied by every season on file, blowing straight
  // through Cloudflare Workers' per-request subrequest limit ("Too many
  // subrequests by single Worker invocation") once there were more than a
  // handful of seasons — exactly what broke Admin > Champions and the public
  // Champions page.
  const [drivers, exhibitionIds, classes, bulkScores, allRounds, rulesets] = await Promise.all([
    driversSelect(env),
    getStandingsExcludedRoundIds(env),
    getDriverClasses(env),
    getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
    getAllRounds(env),
    getScoringRulesets(env),
  ]);

  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
  ]);

  const perSeason = await Promise.all(
    championshipSeasons.map(async (season) => {
      // Pure in-memory filtering from here down — no network calls inside
      // this per-season loop, same as computeDriverCareerStats.
      const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
      if (seasonScores.length === 0) return null;
      const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
      const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
      const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

      const overallContext = buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        seasonScores,
        seasonRawResults,
        seasonPenalties,
        seasonRounds,
        seasonLapStats,
        resolveSeasonRuleset(season, rulesets)?.rules ?? null,
      );

      const classScores = seasonScores.filter((s) => s.class_id === classId);
      const standings = await computeSeasonStandings(
        env,
        season,
        classId,
        drivers,
        exhibitionIds,
        classes,
        overallContext,
        classScores,
        rulesets,
      );
      return standings.length > 0 ? { season, standing: standings[0] } : null;
    }),
  );
  return perSeason.filter((r): r is ChampionEntry => r !== null);
}

/**
 * Same per-season champion list as getChampions(), but additionally
 * resolves each champion's DriverSeasonExtras (cars/teams raced that
 * season) — built for the public Champions page, which used to call
 * getChampions() and then a SEPARATE per-champion getSeasonCarTeamStats()
 * call. That old pattern issued a fresh round of queries per season/champion
 * and started tripping Cloudflare Workers' "Too many subrequests by single
 * Worker invocation" limit once enough seasons had real standings data — the
 * exact same class of bug getChampions() itself already had to fix (see that
 * function's own doc comment). This function reuses the SAME per-season
 * overallContext getChampions() already builds when calling
 * getSeasonCarTeamStats (via its precomputedOverallContext param), so no
 * extra per-season network calls are introduced.
 *
 * Kept as a separate function rather than folding into getChampions() itself
 * — Admin > Champions only needs the plain champion list and shouldn't pay
 * for extras it never renders.
 */
export async function getChampionsWithExtras(
  env: SupabaseEnv,
  seasons: Season[],
  classId: number,
): Promise<{ champions: ChampionEntry[]; extrasBySeasonId: Map<string, DriverSeasonExtras | undefined> }> {
  // Same isDecidedChampionshipSeason gate as getChampions() above.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  const [drivers, exhibitionIds, classes, bulkScores, allRounds, teams, carLogos, seasonLogoRows, rulesets] =
    await Promise.all([
      driversSelect(env),
      getStandingsExcludedRoundIds(env),
      getDriverClasses(env),
      getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
      getAllRounds(env),
      getTeamsBasic(env),
      getCarLogos(env),
      getAllTeamSeasonLogosSafe(env),
      getScoringRulesets(env),
    ]);

  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
  ]);

  const extrasBySeasonId = new Map<string, DriverSeasonExtras | undefined>();

  const perSeason = await Promise.all(
    championshipSeasons.map(async (season) => {
      // Pure in-memory filtering from here down — no network calls inside
      // this per-season loop except the one getSeasonCarTeamStats call
      // below, which itself reuses overallContext and skips its own
      // race_scores/curated_race_results fetches — same "bulk-fetch once,
      // slice in memory" shape as getChampions().
      const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
      if (seasonScores.length === 0) return null;
      const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
      const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
      const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

      const overallContext = buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        seasonScores,
        seasonRawResults,
        seasonPenalties,
        seasonRounds,
        seasonLapStats,
        resolveSeasonRuleset(season, rulesets)?.rules ?? null,
      );

      const classScores = seasonScores.filter((s) => s.class_id === classId);
      const standings = await computeSeasonStandings(
        env,
        season,
        classId,
        drivers,
        exhibitionIds,
        classes,
        overallContext,
        classScores,
        rulesets,
      );
      if (standings.length === 0) return null;

      const champion = standings[0];
      const extras = await getSeasonCarTeamStats(
        env,
        season,
        exhibitionIds,
        drivers,
        teams,
        carLogos,
        seasonLogoRows,
        overallContext,
      );
      extrasBySeasonId.set(season.id, extras.get(champion.driver.id));

      return { season, standing: champion };
    }),
  );

  return {
    champions: perSeason.filter((r): r is ChampionEntry => r !== null),
    extrasBySeasonId,
  };
}

export interface TeamChampionEntry {
  season: Season;
  standing: TeamSeasonStanding;
}

/**
 * Team-championship analogue of getChampions() — one entry per season the
 * given team competition (the OVERALL/cross-class competition when classId
 * is omitted, otherwise that class's own separate competition — same split
 * computeTeamSeasonStandings' own doc comment describes) has any
 * race_scores data for, newest season first. Built for the public
 * Champions page's Alpha Team / Delta Team filters.
 *
 * Same bulk-fetch-once-then-slice-in-memory shape as getChampions() (see
 * that function's own doc comment for the exact Cloudflare Workers
 * subrequest-limit bug this avoids) — computeTeamSeasonStandings is handed
 * every ingredient it would otherwise fetch itself for a given season
 * (precomputedOverallContext, and for the per-class branch,
 * precomputedScoresRaw too), so its own per-season body makes zero network
 * calls here. A season with no rows for the requested competition (e.g.
 * Delta before it existed, or before it was enabled) is skipped
 * automatically, same as getChampions() skips a class's pre-existence.
 */
export async function getTeamChampions(
  env: SupabaseEnv,
  seasons: Season[],
  classId?: number,
): Promise<TeamChampionEntry[]> {
  // Same isDecidedChampionshipSeason gate as getChampions() above.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  const [drivers, exhibitionIds, classes, teamsBasic, seasonLogoRows, bulkScores, allRounds, rulesets] =
    await Promise.all([
      driversSelect(env),
      getStandingsExcludedRoundIds(env),
      getDriverClasses(env),
      getTeamsBasic(env),
      getAllTeamSeasonLogosSafe(env),
      getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
      getAllRounds(env),
      getScoringRulesets(env),
    ]);

  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
  ]);

  const perSeason = await Promise.all(
    championshipSeasons.map(async (season) => {
      // Pure in-memory filtering from here down — no network calls inside
      // this per-season loop, same as getChampions().
      const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
      if (seasonScores.length === 0) return null;
      const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
      const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
      const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

      const overallContext = buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        seasonScores,
        seasonRawResults,
        seasonPenalties,
        seasonRounds,
        seasonLapStats,
        resolveSeasonRuleset(season, rulesets)?.rules ?? null,
      );

      const precomputedScoresRaw =
        classId !== undefined ? seasonScores.filter((s) => s.class_id === classId) : undefined;

      const standings = await computeTeamSeasonStandings(
        env,
        season,
        exhibitionIds,
        classId,
        drivers,
        teamsBasic,
        seasonLogoRows,
        classes,
        overallContext,
        precomputedScoresRaw,
      );
      return standings.length > 0 ? { season, standing: standings[0] } : null;
    }),
  );
  return perSeason.filter((r): r is TeamChampionEntry => r !== null);
}
