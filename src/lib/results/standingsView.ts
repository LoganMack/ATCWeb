/**
 * The data the standings page's drivers views and the home page's top 5 widget show, from the stored round
 * stats (BR2.1, BR2.2), with today's live path as the fallback for a season whose stored rows are incomplete.
 * The pages call these after their first stage of reference reads, so a render takes at most three stages.
 */
import type { SupabaseEnv } from '../db/client';
import type { CarLogo } from '../db/assets';
import type { Circuit, CircuitLayout } from '../db/circuits';
import type { Lookup } from '../db/lookups';
import { getPenaltiesForSubsessions } from '../db/penalties';
import type { ScoringRuleset, Season } from '../db/seasons';
import type { DriverBasic, TeamBasic } from './rows';
import { computeDisplayRoundNumbers } from './rounds';
import {
  computeSeasonStandingsRoundColumns,
  type DriverSeasonStanding,
  type SeasonStandingsRoundColumn,
} from './standingsCore';
import { computeOverallSeasonStandings, computeSeasonStandings } from './standings';
import { computeTeamSeasonStandings, type TeamSeasonStanding } from './teamStandings';
import { getSeasonCarTeamStats, type DriverSeasonExtras } from './seasonCarTeam';
import { getSeasonDriverExtendedStats, type DriverSeasonExtendedStats } from './extendedStats';
import { getSeasonOverallContext } from './seasonContext';
import {
  carTeamStatsFromRounds,
  classStandingsFromRounds,
  extendedStatsFromRounds,
  loadStoredSeasons,
  overallStandingsFromRounds,
  seasonDenominators,
  teamStandingsFromRounds,
  viewSubsessionIds,
} from './roundStatsAdapter';

/** Reference data read in the page's first stage. */
export interface StandingsViewRefs {
  classes: Lookup[];
  drivers: DriverBasic[];
  excludedIds: Set<number>;
  rulesets: ScoringRuleset[];
  teams: TeamBasic[];
  carLogos: CarLogo[];
  seasonLogoRows: { team_id: string; season_id: string; logo_url: string }[];
  circuits: Circuit[];
  layouts: CircuitLayout[];
}

export interface DriverStandingsView {
  standings: DriverSeasonStanding[];
  extras: Map<string, DriverSeasonExtras>;
  extendedStats: Map<string, DriverSeasonExtendedStats>;
  /** Every round this view raced, in order. */
  matrixColumns: SeasonStandingsRoundColumn[];
  colDenoms: { s: number; a: number }[];
  maxStarts: number;
  maxAppearances: number;
  /** Which path built it, for the logs and tests. */
  source: 'stored' | 'live';
}

/** One season's drivers view: `classId` undefined is every class combined (the overall view). */
export async function loadDriverStandingsView(
  env: SupabaseEnv,
  season: Season,
  classId: number | undefined,
  refs: StandingsViewRefs,
): Promise<DriverStandingsView> {
  // The drivers views show penalty points but no team standings.
  const load = await loadStoredSeasons(env, [season], refs.excludedIds, {
    teamCompetitions: [],
    penaltyPoints: true,
  });
  const stats = load.stats.get(season.id);
  if (!stats) return liveDriverStandingsView(env, season, classId, refs);

  const allIds = [...viewSubsessionIds(stats, undefined)];
  // Only the Matrix cells' penalty summaries need the penalty rows themselves.
  const penalties = await getPenaltiesForSubsessions(env, allIds);
  const standingsRefs = { drivers: refs.drivers, rulesets: refs.rulesets, classes: refs.classes, penalties };
  const standings =
    classId !== undefined
      ? classStandingsFromRounds(stats, classId, standingsRefs)
      : overallStandingsFromRounds(stats, standingsRefs);
  const displayRoundNumbers = computeDisplayRoundNumbers(stats.rounds, refs.excludedIds, new Set());
  const matrixColumns = computeSeasonStandingsRoundColumns(
    stats.rounds,
    viewSubsessionIds(stats, classId),
    displayRoundNumbers,
  );
  return {
    standings,
    extras: carTeamStatsFromRounds(stats, refs),
    extendedStats: extendedStatsFromRounds(stats, refs),
    matrixColumns,
    ...seasonDenominators(stats, matrixColumns),
    source: 'stored',
  };
}

/** Today's path: one season context shared by every builder. */
async function liveDriverStandingsView(
  env: SupabaseEnv,
  season: Season,
  classId: number | undefined,
  refs: StandingsViewRefs,
): Promise<DriverStandingsView> {
  const { drivers, excludedIds, classes, rulesets } = refs;
  const overallContext = await getSeasonOverallContext(env, season, excludedIds, drivers);
  const classScores = (id: number) => overallContext.overallScores.filter((s) => s.class_id === id);
  const [standings, extras, extendedStats] = await Promise.all([
    classId !== undefined
      ? computeSeasonStandings(
          env,
          season,
          classId,
          drivers,
          excludedIds,
          classes,
          overallContext,
          classScores(classId),
          rulesets,
        )
      : computeOverallSeasonStandings(env, season, drivers, excludedIds, overallContext, rulesets),
    getSeasonCarTeamStats(
      env,
      season,
      excludedIds,
      drivers,
      refs.teams,
      refs.carLogos,
      refs.seasonLogoRows,
      overallContext,
    ),
    getSeasonDriverExtendedStats(
      env,
      season,
      excludedIds,
      drivers,
      overallContext,
      refs.circuits,
      refs.layouts,
    ),
  ]);
  const scores = overallContext.overallScores;
  const matrixSubsessionIds = new Set(
    (classId !== undefined ? scores.filter((s) => s.class_id === classId) : scores).map(
      (s) => s.subsession_id,
    ),
  );
  const displayRoundNumbers = computeDisplayRoundNumbers(overallContext.seasonRounds, excludedIds, new Set());
  const matrixColumns = computeSeasonStandingsRoundColumns(
    overallContext.seasonRounds,
    matrixSubsessionIds,
    displayRoundNumbers,
  );
  // "x of y" denominators: races and rounds the whole season (every class) had run, as of each column.
  const startTimeBySubsession = new Map(
    overallContext.seasonRounds.map((r) => [r.subsession_id, r.start_time]),
  );
  const racesBySubsession = new Map<number, Set<number>>();
  for (const sc of scores) {
    if (!racesBySubsession.has(sc.subsession_id)) racesBySubsession.set(sc.subsession_id, new Set());
    racesBySubsession.get(sc.subsession_id)!.add(sc.race_number);
  }
  const roundList = [...racesBySubsession].map(([id, races]) => ({
    t: startTimeBySubsession.get(id) ?? '',
    races: races.size,
  }));
  return {
    standings,
    extras,
    extendedStats,
    matrixColumns,
    colDenoms: matrixColumns.map((col) => {
      const through = roundList.filter((r) => r.t <= col.startTime);
      return { s: through.reduce((sum, r) => sum + r.races, 0), a: through.length };
    }),
    maxStarts: new Set(scores.map((s) => `${s.subsession_id}:${s.race_number}`)).size,
    maxAppearances: new Set(scores.map((s) => s.subsession_id)).size,
    source: 'live',
  };
}

export interface HomeStandings {
  overall: DriverSeasonStanding[];
  /** In `refs.classes` order. */
  byClass: { classId: number; rows: DriverSeasonStanding[] }[];
  /** One entry per requested team competition (by class id), in the requested order. */
  teams: { classId: number; rows: TeamSeasonStanding[] }[];
  extras: Map<string, DriverSeasonExtras>;
}

/**
 * The home page widget's tabs from one stored read of the current season: overall, each class, and each
 * class's own team competition asked for (Alpha Team, and Delta Team when that season runs it).
 */
export async function loadHomeStandings(
  env: SupabaseEnv,
  season: Season,
  teamClassIds: number[],
  refs: Omit<StandingsViewRefs, 'circuits' | 'layouts'>,
): Promise<HomeStandings> {
  const load = await loadStoredSeasons(env, [season], refs.excludedIds, {
    teamCompetitions: teamClassIds.map(String),
    penaltyPoints: false,
  });
  const stats = load.stats.get(season.id);
  const { classes, drivers, excludedIds, rulesets, teams, carLogos, seasonLogoRows } = refs;
  if (stats) {
    const standingsRefs = { drivers, rulesets, classes };
    return {
      overall: overallStandingsFromRounds(stats, standingsRefs),
      byClass: classes.map((c) => ({
        classId: c.id,
        rows: classStandingsFromRounds(stats, c.id, standingsRefs),
      })),
      teams: teamClassIds.map((classId) => ({
        classId,
        rows: teamStandingsFromRounds(stats, classId, { teams, seasonLogoRows }),
      })),
      extras: carTeamStatsFromRounds(stats, { teams, carLogos, seasonLogoRows }),
    };
  }

  // Live fallback, as the page computed it before: one season context shared by every tab.
  const overallContext = await getSeasonOverallContext(env, season, excludedIds, drivers);
  const classScores = (id: number) => overallContext.overallScores.filter((s) => s.class_id === id);
  const [overall, extras, byClass, teamTabs] = await Promise.all([
    computeOverallSeasonStandings(env, season, drivers, excludedIds, overallContext, rulesets),
    getSeasonCarTeamStats(env, season, excludedIds, drivers, teams, carLogos, seasonLogoRows, overallContext),
    Promise.all(
      classes.map(async (c) => ({
        classId: c.id,
        rows: await computeSeasonStandings(
          env,
          season,
          c.id,
          drivers,
          excludedIds,
          classes,
          overallContext,
          classScores(c.id),
          rulesets,
        ),
      })),
    ),
    Promise.all(
      teamClassIds.map(async (classId) => ({
        classId,
        rows: await computeTeamSeasonStandings(
          env,
          season,
          excludedIds,
          classId,
          drivers,
          teams,
          seasonLogoRows,
          classes,
          overallContext,
          classScores(classId),
        ),
      })),
    ),
  ]);
  return { overall, byClass, teams: teamTabs, extras };
}
