import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos } from '../db/assets';
import { getScoringRulesets, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions } from '../db/penalties';
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
  getRaceScoresForSeasonsBulk,
  type DriverBasic,
  type ScoreRow,
} from './rows';
import { buildSeasonOverallContext } from './seasonContext';
import { computeSeasonStandings, computeOverallSeasonStandings } from './standings';
import { computeTeamSeasonStandings } from './teamStandings';
import { getCuratedRaceResultsWithLapStatsBulk, getSeasonDriverExtendedStats } from './extendedStats';
import { getRoundLayoutsForSubsessions } from './layoutLaps';
import { getSeasonCarTeamStats, type DriverCarStat, type DriverTeamStat } from './seasonCarTeam';
import { getAllRounds } from './rounds';

// Career driver stats for the Driver Stats history tab. Nothing is stored: everything is recomputed from
// every championship season, so a new driver appears on the next page load.

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

/**
 * Every driver's career stat line, aggregated from the same per-season computations the Champions and
 * Standings pages use, over championship seasons only.
 */
export async function computeDriverCareerStats(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>,
): Promise<DriverCareerStats[]> {
  const championshipSeasons = seasons.filter((s) => isChampionshipSeason(s.name));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  // Each of these is fetched once for the whole career and sliced per season in memory: any per-season query
  // exceeds the Workers subrequest limit as seasons accumulate.
  const [
    drivers,
    exhibitionIds,
    teams,
    carLogos,
    seasonLogoRows,
    circuits,
    layouts,
    bulkScores,
    allRounds,
    rulesets,
  ] = await Promise.all([
    driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
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
    getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
    getAllRounds(env),
    getScoringRulesets(env),
  ]);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  // Delta runs its own separate team competition (see computeTeamSeasonStandings'
  // own doc comment) — every other class's drivers just show "—" for
  // deltaTeamPosition unless their team happens to also field a Delta driver.
  const deltaClass = classes.find((c) => c.name === 'Delta');

  // The per-subsession queries run once over every subsession any championship season touches, not once per
  // season.
  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties, roundLayouts] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
    getRoundLayoutsForSubsessions(env, allSubsessionIds),
  ]);

  const seasonRowsByDriver = new Map<string, DriverCareerSeasonRow[]>();

  for (const season of championshipSeasons) {
    // Slice this whole run's bulk fetches down to just this season — pure
    // in-memory filtering (a subsession only ever belongs to one season),
    // no network calls anywhere in this loop.
    const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
    if (seasonScores.length === 0) continue;
    const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
    const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
    const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
    const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
    const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

    // Same context every single-season page builds via getSeasonOverallContext
    // — built directly here (no fetch) since every ingredient is already an
    // in-memory slice of this run's bulk fetches.
    const overallContext = buildSeasonOverallContext(
      exhibitionIds,
      drivers,
      seasonScores,
      seasonRawResults,
      seasonPenalties,
      seasonRounds,
      seasonLapStats,
    );

    const scoresByClassId = new Map<number, ScoreRow[]>();
    for (const row of seasonScores) {
      if (!scoresByClassId.has(row.class_id)) scoresByClassId.set(row.class_id, []);
      scoresByClassId.get(row.class_id)!.push(row);
    }

    const [
      classStandingsByClass,
      overallStandings,
      extendedStats,
      teamStandingsOverall,
      teamStandingsDelta,
      carTeamStats,
    ] = await Promise.all([
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
      // Gated on delta_team_enabled: the Delta class raced from ATC5 but the Delta team championship only
      // began at ATC10 (0052_delta_team_enabled.sql).
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

    const overallPositionByDriverId = new Map(overallStandings.map((s) => [s.driver.id, s.position]));
    const teamPositionByTeamId = new Map(teamStandingsOverall.map((t) => [t.teamId, t.position]));
    const deltaTeamPositionByTeamId = new Map(teamStandingsDelta.map((t) => [t.teamId, t.position]));

    classes.forEach((cls, i) => {
      for (const standing of classStandingsByClass[i]) {
        const driverId = standing.driver.id;
        const extras = carTeamStats.get(driverId);
        const ext = extendedStats.get(driverId);
        // getSeasonCarTeamStats already sorts a driver's teams by
        // racesUnderTeam descending — [0] is their primary team that
        // season (the only one relevant for "their team's standing").
        const primaryTeam = extras?.teams[0] ?? null;

        const row: DriverCareerSeasonRow = {
          season,
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
