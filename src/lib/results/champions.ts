import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos } from '../db/assets';
import { getScoringRulesets, type Season } from '../db/seasons';
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
 * One entry per season the class has results for, newest first. Seasons before a class existed simply have no
 * rows, so no cutoffs are hardcoded.
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

  // Bulk-fetched once across every season and sliced in memory, to stay under the Workers subrequest limit.
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
 * getChampions() plus each champion's cars and teams that season, for the public Champions page. It reuses
 * getChampions()' per-season context so no per-season queries are added; Admin > Champions keeps the plain
 * list.
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
      // In-memory filtering from here; the one getSeasonCarTeamStats call reuses overallContext and skips its
      // own fetches.
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
 * Team analogue of getChampions(): one entry per season the team competition (overall, or one class's) has
 * results for, newest first. Every ingredient is passed in precomputed so the per-season body makes no
 * network calls.
 */
export async function getTeamChampions(
  env: SupabaseEnv,
  seasons: Season[],
  classId?: number,
): Promise<TeamChampionEntry[]> {
  // Same isDecidedChampionshipSeason gate as getChampions() above.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  const [drivers, exhibitionIds, classes, teamsBasic, seasonLogoRows, bulkScores, allRounds] =
    await Promise.all([
      driversSelect(env),
      getStandingsExcludedRoundIds(env),
      getDriverClasses(env),
      getTeamsBasic(env),
      getAllTeamSeasonLogosSafe(env),
      getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
      getAllRounds(env),
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
