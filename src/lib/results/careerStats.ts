import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos, type CarLogo } from '../db/assets';
import { getScoringRulesets, type ScoringRuleset, type Season } from '../db/seasons';
import type { Lookup } from '../db/lookups';
import {
  displayDriverName,
  getCircuits,
  getAllCircuitLayouts,
  type Circuit,
  type CircuitLayout,
} from '../db/circuits';
import { isChampionshipSeason } from './shared';
import {
  driversSelect,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  type DriverBasic,
  type ScoreRow,
  type TeamBasic,
} from './rows';
import { computeSeasonStandings, computeOverallSeasonStandings } from './standings';
import { computeTeamSeasonStandings, type TeamSeasonStanding } from './teamStandings';
import { getSeasonDriverExtendedStats, type DriverSeasonExtendedStats } from './extendedStats';
import {
  getSeasonCarTeamStats,
  type DriverCarStat,
  type DriverSeasonExtras,
  type DriverTeamStat,
} from './seasonCarTeam';
import type { DriverSeasonStanding } from './standingsCore';
import { loadLiveSeasonInputs } from './liveSeasons';
import {
  carTeamStatsFromRounds,
  classStandingsFromRounds,
  extendedStatsFromRounds,
  loadStoredSeasons,
  overallStandingsFromRounds,
  teamStandingsFromRounds,
  type SeasonRoundStats,
} from './roundStatsAdapter';

// Career driver stats for the Driver Stats history tab, built from the stored round stats of every
// championship season (BR2.3); a season whose stored rows are incomplete is computed live for that render.

/** One driver's stat line for one season (they raced exactly one class in a season, so this is also effectively "one class" — the class is carried on the row for display/grouping, not because a driver could have two rows in the same season). */
export interface DriverCareerSeasonRow {
  season: Season;
  classId: number;
  className: string;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  starts: number;
  appearances: number;
  laps: number;
  lapsLed: number;
  incidents: number;
  /** Null under the same "nothing resolved to a layout with a corner count" condition DriverSeasonExtendedStats.totalCorners uses — see that field's own doc comment. */
  totalCorners: number | null;
  /** This driver's position in that season's class standings — 1 means they won that class's championship that season. */
  classPosition: number;
  /** This driver's position in that season's cross-class Overall driver standings. Null only if they somehow don't appear there despite having class_scores rows — shouldn't normally happen. */
  overallPosition: number | null;
  /** The overall (cross-class) Team Standings position of this driver's PRIMARY team that season (the team they raced under most, when they raced under more than one — see `teams` below for the full breakdown) — null if they had no team that season. */
  teamPosition: number | null;
  /** Same idea, but the Delta-only team competition's position for that same primary team — null if they had no team, or their team didn't score in the Delta competition that season (e.g. no Delta driver on the team, or this driver's own class isn't Delta and no teammate raced Delta either). */
  deltaTeamPosition: number | null;
  cars: DriverCarStat[];
  teams: DriverTeamStat[];
}

export interface DriverCareerStats {
  driver: DriverBasic;
  /** Count of seasons this driver finished 1st in their class's standings — summed across every class they've ever raced, not just their current one. */
  championships: number;
  wins: number;
  podiums: number;
  poles: number;
  top5s: number;
  top10s: number;
  laps: number;
  lapsLed: number;
  starts: number;
  appearances: number;
  /** Career-wide corners-per-incident — deliberately NOT an average of each season's own cornersPerIncident (that would over-weight low-incident seasons); it's total corners navigated across every season that resolved a corner count, divided by total incidents across the WHOLE career. Null under the same "nothing to compute from" conditions the per-season figure uses. */
  cornersPerIncident: number | null;
  /** Newest season first — same ordering the Champions/Standings pages use. */
  seasons: DriverCareerSeasonRow[];
}

/**
 * Rolls a driver's season rows into one career stat line (pure aggregation). The Driver Stats class filters
 * call it again with one class's rows; callers choose the rows.
 */
export function aggregateDriverCareerStats(
  driver: DriverBasic,
  seasonRows: DriverCareerSeasonRow[],
): DriverCareerStats {
  let championships = 0;
  let wins = 0;
  let podiums = 0;
  let poles = 0;
  let top5s = 0;
  let top10s = 0;
  let laps = 0;
  let lapsLed = 0;
  let starts = 0;
  let appearances = 0;
  let totalCorners = 0;
  let totalIncidents = 0;
  let anyCornersResolved = false;

  for (const r of seasonRows) {
    // A season still in progress doesn't count as a championship yet; its other stats count in real time
    // (Logan).
    if (r.classPosition === 1 && !r.season.is_current) championships++;
    wins += r.wins;
    podiums += r.podiums;
    poles += r.poles;
    top5s += r.top5s;
    top10s += r.top10s;
    laps += r.laps;
    lapsLed += r.lapsLed;
    starts += r.starts;
    appearances += r.appearances;
    totalIncidents += r.incidents;
    if (r.totalCorners !== null) {
      totalCorners += r.totalCorners;
      anyCornersResolved = true;
    }
  }

  return {
    driver,
    championships,
    wins,
    podiums,
    poles,
    top5s,
    top10s,
    laps,
    lapsLed,
    starts,
    appearances,
    cornersPerIncident: anyCornersResolved && totalIncidents > 0 ? totalCorners / totalIncidents : null,
    seasons: seasonRows,
  };
}

/** The reference data every career season reads, fetched once per render: start it in the page's first stage. */
export interface CareerRefs {
  drivers: DriverBasic[];
  teams: TeamBasic[];
  carLogos: CarLogo[];
  seasonLogoRows: { team_id: string; season_id: string; logo_url: string }[];
  circuits: Circuit[];
  layouts: CircuitLayout[];
  rulesets: ScoringRuleset[];
}

export async function loadCareerRefs(env: SupabaseEnv): Promise<CareerRefs> {
  const [drivers, teams, carLogos, seasonLogoRows, circuits, layouts, rulesets] = await Promise.all([
    driversSelect(env),
    getTeamsBasic(env),
    getCarLogos(env),
    getAllTeamSeasonLogosSafe(env),
    getCircuits(env).catch((err) => {
      console.error(
        'Failed to fetch circuits for career distance/corners-per-incident stats — both will be omitted:',
        err,
      );
      return [] as Circuit[];
    }),
    getAllCircuitLayouts(env).catch((err) => {
      console.error(
        'Failed to fetch circuit_layouts for career distance/corners-per-incident stats — both will be omitted:',
        err,
      );
      return [] as CircuitLayout[];
    }),
    getScoringRulesets(env),
  ]);
  return { drivers, teams, carLogos, seasonLogoRows, circuits, layouts, rulesets };
}

/** One season's standings, team standings, extended stats and cars and teams, from either path. */
interface SeasonViews {
  season: Season;
  /** In `classes` order. */
  classStandings: DriverSeasonStanding[][];
  overallStandings: DriverSeasonStanding[];
  extendedStats: Map<string, DriverSeasonExtendedStats>;
  teamOverall: TeamSeasonStanding[];
  teamDelta: TeamSeasonStanding[];
  carTeamStats: Map<string, DriverSeasonExtras>;
}

function storedSeasonViews(stats: SeasonRoundStats, classes: Lookup[], refs: CareerRefs): SeasonViews {
  const { season } = stats;
  // Delta's team championship only began at ATC10 (0052_delta_team_enabled.sql).
  const deltaClass = classes.find((c) => c.name === 'Delta');
  const standingsRefs = { drivers: refs.drivers, rulesets: refs.rulesets, classes };
  return {
    season,
    classStandings: classes.map((c) => classStandingsFromRounds(stats, c.id, standingsRefs)),
    overallStandings: overallStandingsFromRounds(stats, standingsRefs),
    extendedStats: extendedStatsFromRounds(stats, refs),
    teamOverall: teamStandingsFromRounds(stats, undefined, refs),
    teamDelta:
      deltaClass && season.delta_team_enabled ? teamStandingsFromRounds(stats, deltaClass.id, refs) : [],
    carTeamStats: carTeamStatsFromRounds(stats, refs),
  };
}

/** The live path for the seasons the stored rows can't serve: one bulk read, then no network per season. */
async function liveSeasonViews(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionIds: Set<number>,
  refs: CareerRefs,
): Promise<SeasonViews[]> {
  const { drivers, teams, carLogos, seasonLogoRows, circuits, layouts, rulesets } = refs;
  const { bySeasonId, roundLayouts } = await loadLiveSeasonInputs(env, seasons, drivers, exhibitionIds, {
    withRoundLayouts: true,
  });
  const deltaClass = classes.find((c) => c.name === 'Delta');
  const out: SeasonViews[] = [];
  for (const season of seasons) {
    const live = bySeasonId.get(season.id);
    if (!live) continue;
    const overallContext = live.context;
    const scoresByClassId = new Map<number, ScoreRow[]>();
    for (const row of live.scores) {
      if (!scoresByClassId.has(row.class_id)) scoresByClassId.set(row.class_id, []);
      scoresByClassId.get(row.class_id)!.push(row);
    }
    const [classStandings, overallStandings, extendedStats, teamOverall, teamDelta, carTeamStats] =
      await Promise.all([
        Promise.all(
          classes.map((c) =>
            computeSeasonStandings(
              env,
              season,
              c.id,
              drivers,
              exhibitionIds,
              classes,
              overallContext,
              scoresByClassId.get(c.id) ?? [],
              rulesets,
            ),
          ),
        ),
        computeOverallSeasonStandings(env, season, drivers, exhibitionIds, overallContext, rulesets),
        getSeasonDriverExtendedStats(
          env,
          season,
          exhibitionIds,
          drivers,
          overallContext,
          circuits,
          layouts,
          roundLayouts,
        ),
        computeTeamSeasonStandings(
          env,
          season,
          exhibitionIds,
          undefined,
          drivers,
          teams,
          seasonLogoRows,
          classes,
          overallContext,
        ),
        deltaClass && season.delta_team_enabled
          ? computeTeamSeasonStandings(
              env,
              season,
              exhibitionIds,
              deltaClass.id,
              drivers,
              teams,
              seasonLogoRows,
              classes,
              overallContext,
              scoresByClassId.get(deltaClass.id) ?? [],
            )
          : Promise.resolve([]),
        getSeasonCarTeamStats(
          env,
          season,
          exhibitionIds,
          drivers,
          teams,
          carLogos,
          seasonLogoRows,
          overallContext,
        ),
      ]);
    out.push({
      season,
      classStandings,
      overallStandings,
      extendedStats,
      teamOverall,
      teamDelta,
      carTeamStats,
    });
  }
  return out;
}

/** Appends one season's row for every driver in its class standings. */
function addSeasonRows(
  views: SeasonViews,
  classes: Lookup[],
  seasonRowsByDriver: Map<string, DriverCareerSeasonRow[]>,
): void {
  const overallPositionByDriverId = new Map(views.overallStandings.map((s) => [s.driver.id, s.position]));
  const teamPositionByTeamId = new Map(views.teamOverall.map((t) => [t.teamId, t.position]));
  const deltaTeamPositionByTeamId = new Map(views.teamDelta.map((t) => [t.teamId, t.position]));

  classes.forEach((cls, i) => {
    for (const standing of views.classStandings[i]) {
      const driverId = standing.driver.id;
      const extras = views.carTeamStats.get(driverId);
      const ext = views.extendedStats.get(driverId);
      // A driver's teams are sorted by races under each, so [0] is their primary team that season.
      const primaryTeam = extras?.teams[0] ?? null;

      const row: DriverCareerSeasonRow = {
        season: views.season,
        classId: cls.id,
        className: cls.name,
        wins: standing.wins,
        podiums: standing.podiums,
        top5s: standing.top5s,
        top10s: standing.top10s,
        poles: standing.poles,
        starts: standing.starts,
        appearances: standing.appearances,
        laps: standing.laps,
        lapsLed: standing.lapsLed,
        incidents: ext?.incidents ?? 0,
        totalCorners: ext?.totalCorners ?? null,
        classPosition: standing.position,
        overallPosition: overallPositionByDriverId.get(driverId) ?? null,
        teamPosition: primaryTeam ? (teamPositionByTeamId.get(primaryTeam.teamId) ?? null) : null,
        deltaTeamPosition: primaryTeam ? (deltaTeamPositionByTeamId.get(primaryTeam.teamId) ?? null) : null,
        cars: extras?.cars ?? [],
        teams: extras?.teams ?? [],
      };

      if (!seasonRowsByDriver.has(driverId)) seasonRowsByDriver.set(driverId, []);
      seasonRowsByDriver.get(driverId)!.push(row);
    }
  });
}

/** driver id -> their season rows over `seasons`: stored where complete, live for the rest. */
async function careerSeasonRows(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionIds: Set<number>,
  refs: CareerRefs,
): Promise<Map<string, DriverCareerSeasonRow[]>> {
  // A career row needs the overall and Delta team positions, and no penalty points.
  const deltaClass = classes.find((c) => c.name === 'Delta');
  const load = await loadStoredSeasons(env, seasons, exhibitionIds, {
    teamCompetitions: ['overall', ...(deltaClass ? [String(deltaClass.id)] : [])],
    penaltyPoints: false,
  });
  const views: SeasonViews[] = [];
  for (const season of seasons) {
    const stats = load.stats.get(season.id);
    if (stats) views.push(storedSeasonViews(stats, classes, refs));
  }
  if (load.live.length > 0)
    views.push(...(await liveSeasonViews(env, load.live, classes, exhibitionIds, refs)));
  // In `seasons` order, so each driver's rows reach the sort in the order the live path always gave them.
  const order = new Map(seasons.map((s, i) => [s.id, i]));
  views.sort((a, b) => (order.get(a.season.id) ?? 0) - (order.get(b.season.id) ?? 0));

  const seasonRowsByDriver = new Map<string, DriverCareerSeasonRow[]>();
  for (const v of views) addSeasonRows(v, classes, seasonRowsByDriver);
  return seasonRowsByDriver;
}

/**
 * Every driver's career stat line, aggregated from the same per-season computations the Champions and
 * Standings pages use, over championship seasons only. Pass `refs` when the page already started
 * loadCareerRefs, so the stored reads are its second stage.
 */
export async function computeDriverCareerStats(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>,
  refs?: CareerRefs,
): Promise<DriverCareerStats[]> {
  const championshipSeasons = seasons.filter((s) => isChampionshipSeason(s.name));
  const [exhibitionIds, careerRefs] = await Promise.all([
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    refs ? Promise.resolve(refs) : loadCareerRefs(env),
  ]);
  const seasonRowsByDriver = await careerSeasonRows(
    env,
    championshipSeasons,
    classes,
    exhibitionIds,
    careerRefs,
  );

  const driverById = new Map(careerRefs.drivers.map((d) => [d.id, d]));
  const out: DriverCareerStats[] = [];
  for (const [driverId, seasonRows] of seasonRowsByDriver) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    seasonRows.sort((a, b) => b.season.number - a.season.number);
    out.push(aggregateDriverCareerStats(driver, seasonRows));
  }

  out.sort((a, b) => displayDriverName(a.driver.name).localeCompare(displayDriverName(b.driver.name)));
  return out;
}

/**
 * One driver's career for their profile (BR1.1): only the seasons they have stored rows in, read with every
 * driver of those seasons so positions rank as on the standings pages. `driverSeasonIds` null (their stored
 * rows can't be trusted) uses every championship season, as the live path did.
 */
export async function computeDriverCareer(
  env: SupabaseEnv,
  driverId: string,
  seasons: Season[],
  classes: Lookup[],
  exhibitionIds: Set<number>,
  refs: CareerRefs,
  driverSeasonIds: Set<string> | null,
): Promise<DriverCareerStats | null> {
  const targetSeasons = seasons.filter(
    (s) => isChampionshipSeason(s.name) && (driverSeasonIds === null || driverSeasonIds.has(s.id)),
  );
  const seasonRows = (await careerSeasonRows(env, targetSeasons, classes, exhibitionIds, refs)).get(driverId);
  const driver = refs.drivers.find((d) => d.id === driverId);
  if (!driver || !seasonRows) return null;
  seasonRows.sort((a, b) => b.season.number - a.season.number);
  return aggregateDriverCareerStats(driver, seasonRows);
}
