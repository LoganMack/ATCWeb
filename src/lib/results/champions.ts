import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos } from '../db/assets';
import { getScoringRulesets, type Season } from '../db/seasons';
import { getDriverClasses } from '../db/lookups';
import { isDecidedChampionshipSeason } from './shared';
import { driversSelect, getTeamsBasic, getAllTeamSeasonLogosSafe } from './rows';
import type { DriverSeasonStanding } from './standingsCore';
import { computeSeasonStandings } from './standings';
import { computeTeamSeasonStandings, type TeamSeasonStanding } from './teamStandings';
import { getSeasonCarTeamStats, type DriverSeasonExtras } from './seasonCarTeam';
import { loadLiveSeasonInputs } from './liveSeasons';
import {
  carTeamStatsFromRounds,
  classStandingsFromRounds,
  isStoredTeamCompetition,
  loadStoredSeasons,
  teamStandingsFromRounds,
  type StoredSeasonsLoad,
} from './roundStatsAdapter';

// ---------------------------------------------------------------------------
// Champions — the #1 standing for every season a class actually raced in. Built from the stored round
// stats like every other standings page, so they always agree; a season whose stored rows are incomplete
// is computed live for that render.
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
  return (await championsFor(env, seasons, classId, false)).champions;
}

/**
 * getChampions() plus each champion's cars and teams that season, for the public Champions page. Admin >
 * Champions keeps the plain list.
 */
export async function getChampionsWithExtras(
  env: SupabaseEnv,
  seasons: Season[],
  classId: number,
): Promise<{ champions: ChampionEntry[]; extrasBySeasonId: Map<string, DriverSeasonExtras | undefined> }> {
  return championsFor(env, seasons, classId, true);
}

async function championsFor(
  env: SupabaseEnv,
  seasons: Season[],
  classId: number,
  withExtras: boolean,
): Promise<{ champions: ChampionEntry[]; extrasBySeasonId: Map<string, DriverSeasonExtras | undefined> }> {
  // isDecidedChampionshipSeason, not isChampionshipSeason alone — a season
  // still flagged is_current has no champion to show yet, per Logan.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));

  const [drivers, exhibitionIds, classes, rulesets, teams, carLogos, seasonLogoRows] = await Promise.all([
    driversSelect(env),
    getStandingsExcludedRoundIds(env),
    getDriverClasses(env),
    getScoringRulesets(env),
    withExtras ? getTeamsBasic(env) : Promise.resolve([]),
    withExtras ? getCarLogos(env) : Promise.resolve([]),
    withExtras ? getAllTeamSeasonLogosSafe(env) : Promise.resolve([]),
  ]);
  const load = await loadStoredSeasons(env, championshipSeasons, exhibitionIds, {
    teamCompetitions: [],
    penaltyPoints: false,
  });
  const live = (await loadLiveSeasonInputs(env, load.live, drivers, exhibitionIds)).bySeasonId;

  const extrasBySeasonId = new Map<string, DriverSeasonExtras | undefined>();
  const champions: ChampionEntry[] = [];
  for (const season of championshipSeasons) {
    const stats = load.stats.get(season.id);
    const liveInputs = live.get(season.id);
    let standings: DriverSeasonStanding[];
    if (stats) {
      standings = classStandingsFromRounds(stats, classId, { drivers, rulesets, classes });
    } else if (liveInputs) {
      standings = await computeSeasonStandings(
        env,
        season,
        classId,
        drivers,
        exhibitionIds,
        classes,
        liveInputs.context,
        liveInputs.scores.filter((s) => s.class_id === classId),
        rulesets,
      );
    } else {
      continue;
    }
    if (standings.length === 0) continue;

    const champion = standings[0];
    if (withExtras) {
      const extras = stats
        ? carTeamStatsFromRounds(stats, { teams, carLogos, seasonLogoRows })
        : await getSeasonCarTeamStats(
            env,
            season,
            exhibitionIds,
            drivers,
            teams,
            carLogos,
            seasonLogoRows,
            liveInputs!.context,
          );
      extrasBySeasonId.set(season.id, extras.get(champion.driver.id));
    }
    champions.push({ season, standing: champion });
  }
  return { champions, extrasBySeasonId };
}

export interface TeamChampionEntry {
  season: Season;
  standing: TeamSeasonStanding;
}

/**
 * Team analogue of getChampions(): one entry per season the team competition (overall, or one class's) has
 * results for, newest first.
 */
export async function getTeamChampions(
  env: SupabaseEnv,
  seasons: Season[],
  classId?: number,
): Promise<TeamChampionEntry[]> {
  // Same isDecidedChampionshipSeason gate as getChampions() above.
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));

  const [drivers, exhibitionIds, classes, teamsBasic, seasonLogoRows] = await Promise.all([
    driversSelect(env),
    getStandingsExcludedRoundIds(env),
    getDriverClasses(env),
    getTeamsBasic(env),
    getAllTeamSeasonLogosSafe(env),
  ]);
  // Only the overall, Alpha and Delta team competitions are stored; any other is computed live.
  const load: StoredSeasonsLoad = isStoredTeamCompetition(classId, classes)
    ? await loadStoredSeasons(env, championshipSeasons, exhibitionIds, {
        teamCompetitions: [classId === undefined ? 'overall' : String(classId)],
        penaltyPoints: false,
      })
    : { stats: new Map(), live: championshipSeasons };
  const live = (await loadLiveSeasonInputs(env, load.live, drivers, exhibitionIds)).bySeasonId;

  const out: TeamChampionEntry[] = [];
  for (const season of championshipSeasons) {
    const stats = load.stats.get(season.id);
    const liveInputs = live.get(season.id);
    let standings: TeamSeasonStanding[];
    if (stats) {
      standings = teamStandingsFromRounds(stats, classId, { teams: teamsBasic, seasonLogoRows });
    } else if (liveInputs) {
      standings = await computeTeamSeasonStandings(
        env,
        season,
        exhibitionIds,
        classId,
        drivers,
        teamsBasic,
        seasonLogoRows,
        classes,
        liveInputs.context,
        classId !== undefined ? liveInputs.scores.filter((s) => s.class_id === classId) : undefined,
      );
    } else {
      continue;
    }
    if (standings.length > 0) out.push({ season, standing: standings[0] });
  }
  return out;
}
