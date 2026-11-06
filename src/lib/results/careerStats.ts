import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos, type CarLogo } from '../db/assets';
import { getScoringRulesets, type ScoringRuleset, type Season } from '../db/seasons';
import type { Lookup } from '../db/lookups';
import type { RoundDriverStatsRow, SeasonStatsStatus } from '../db/roundStats';
import {
  addCounts,
  countsFor,
  emptyCounts,
  filterKeepsClass,
  type ClassFilter,
  type StatCounts,
} from './classFilter';
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
  driverCareerSeasons,
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
  /** The class counts above (wins, podiums, top 5s, top 10s, poles) as one value, for countsFor. */
  classCounts: StatCounts;
  /** The same driver's counts from the season's classless Overall standings, over this row's rounds (BR3.2). */
  overallCounts: StatCounts;
  /**
   * One entry per round raced, so teams and cars can be credited round by round (BR4.6, BR4.8). Built only
   * when the caller asks (CareerOptions.withRounds, Compare); empty otherwise.
   */
  rounds: CareerRound[];
}

/** What a career computation builds beyond the season rows every consumer reads. */
export interface CareerOptions {
  /** Build each season row's per-round list. Only Compare reads it, so the other pages skip the work. */
  withRounds?: boolean;
}

/** One driver's results in one championship round, with the team and car it was raced for. */
export interface CareerRound {
  subsessionId: number;
  /** The team raced for that round; null when none. Such a round is credited to no team. */
  teamId: string | null;
  /** The car driven that round (exact iRacing name); null when unknown. Such a round is credited to no car. */
  carName: string | null;
  starts: number;
  laps: number;
  lapsLed: number;
  classCounts: StatCounts;
  overallCounts: StatCounts;
}

/** Which teams won the team competitions in one championship season (BR4.7). */
export interface TeamSeasonTitles {
  season: Season;
  /** Teams at position 1 of the overall team competition (more than one only on an exact tie). */
  overallChampionIds: string[];
  /** Teams at position 1 of the Delta team competition; empty when it did not run that season. */
  deltaChampionIds: string[];
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
 * A driver's career under a class filter (BR3.2-BR3.6): Overall sums the classless counts and counts a title
 * for each finished season at overall position 1; Combined is aggregateDriverCareerStats over every season; a
 * class keeps only that class's seasons. Starts, laps, laps led and corners per incident never depend on
 * Overall vs Combined. `seasons` on the result are the kept rows.
 */
export function aggregateCareer(
  driver: DriverBasic,
  seasonRows: DriverCareerSeasonRow[],
  filter: ClassFilter,
): DriverCareerStats {
  const kept = seasonRows.filter((r) => filterKeepsClass(filter, r.classId));
  const base = aggregateDriverCareerStats(driver, kept);
  if (filter.kind !== 'overall') return base;
  const counts = kept.reduce((sum, r) => addCounts(sum, countsFor(r, filter)), emptyCounts());
  // Per season, not per row: a driver with two class rows in one season carries the same overall position
  // on both, and the season's overall title counts once.
  const championships = new Set(
    kept.filter((r) => r.overallPosition === 1 && !r.season.is_current).map((r) => r.season.id),
  ).size;
  return { ...base, ...counts, championships };
}

/** Whether a season row shows a title trophy under the filter (same gate as aggregateCareer's count). */
export function isFilterChampion(row: DriverCareerSeasonRow, filter: ClassFilter): boolean {
  if (row.season.is_current) return false;
  return filter.kind === 'overall' ? row.overallPosition === 1 : row.classPosition === 1;
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
export interface SeasonViews {
  season: Season;
  /** In `classes` order. */
  classStandings: DriverSeasonStanding[][];
  overallStandings: DriverSeasonStanding[];
  extendedStats: Map<string, DriverSeasonExtendedStats>;
  teamOverall: TeamSeasonStanding[];
  teamDelta: TeamSeasonStanding[];
  carTeamStats: Map<string, DriverSeasonExtras>;
  /**
   * `driverId:subsessionId` -> the team and car of that round, from the stored rows. Null on the live path,
   * where every round takes the season's primary team and most-raced car instead.
   */
  roundTeamCar: Map<string, RoundTeamCar> | null;
}

interface RoundTeamCar {
  teamId: string | null;
  carName: string | null;
}

/** The car of a stored round: its only key, or the most-raced one should a row ever carry two. */
function roundCarName(cars: Record<string, number> | null | undefined): string | null {
  let best: string | null = null;
  let bestRaces = -1;
  for (const [name, races] of Object.entries(cars ?? {})) {
    if (races > bestRaces) {
      best = name;
      bestRaces = races;
    }
  }
  return best;
}

function roundTeamCarFrom(rows: RoundDriverStatsRow[]): Map<string, RoundTeamCar> {
  return new Map(
    rows.map((r) => [
      `${r.driver_id}:${r.subsession_id}`,
      { teamId: r.team_id, carName: roundCarName(r.cars) },
    ]),
  );
}

function storedSeasonViews(
  stats: SeasonRoundStats,
  classes: Lookup[],
  refs: CareerRefs,
  options: CareerOptions,
): SeasonViews {
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
    roundTeamCar: options.withRounds ? roundTeamCarFrom(stats.driverRows) : null,
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
      roundTeamCar: null,
    });
  }
  return out;
}

function countsOf(s: {
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
}): StatCounts {
  return { wins: s.wins, podiums: s.podiums, top5s: s.top5s, top10s: s.top10s, poles: s.poles };
}

/**
 * The driver's classless Overall counts over the rounds of one class standing, so a driver who somehow raced
 * two classes in one season never gets the season's whole overall tally twice.
 */
function overallCountsOver(
  classStanding: DriverSeasonStanding,
  overallStanding: DriverSeasonStanding | undefined,
): StatCounts {
  const sum = emptyCounts();
  if (!overallStanding) return sum;
  for (const subsessionId of classStanding.roundStats.keys()) {
    const rs = overallStanding.roundStats.get(subsessionId);
    if (rs) addCounts(sum, countsOf(rs));
  }
  return sum;
}

/**
 * One driver's rounds in one season, from the class standing's per-round breakdown with the overall
 * standing's breakdown of the same rounds beside it, so both paths give the same CareerRound shape.
 */
function careerRounds(
  classStanding: DriverSeasonStanding,
  overallStanding: DriverSeasonStanding | undefined,
  roundTeamCar: Map<string, RoundTeamCar> | null,
  fallback: RoundTeamCar,
): CareerRound[] {
  const driverId = classStanding.driver.id;
  const rounds: CareerRound[] = [];
  for (const [subsessionId, rs] of classStanding.roundStats) {
    const overall = overallStanding?.roundStats.get(subsessionId);
    const teamCar = roundTeamCar ? roundTeamCar.get(`${driverId}:${subsessionId}`) : fallback;
    rounds.push({
      subsessionId,
      teamId: teamCar?.teamId ?? null,
      carName: teamCar?.carName ?? null,
      starts: rs.starts,
      laps: rs.laps,
      lapsLed: rs.lapsLed,
      classCounts: countsOf(rs),
      overallCounts: overall ? countsOf(overall) : emptyCounts(),
    });
  }
  return rounds.sort((a, b) => a.subsessionId - b.subsessionId);
}

/** The team competition winners of one season, from the standings the career computation already built. */
function teamSeasonTitles(views: SeasonViews): TeamSeasonTitles {
  const winners = (standings: TeamSeasonStanding[]) =>
    standings.filter((t) => t.position === 1).map((t) => t.teamId);
  return {
    season: views.season,
    overallChampionIds: winners(views.teamOverall),
    deltaChampionIds: winners(views.teamDelta),
  };
}

/** Appends one season's row for every driver in its class standings. */
function addSeasonRows(
  views: SeasonViews,
  classes: Lookup[],
  seasonRowsByDriver: Map<string, DriverCareerSeasonRow[]>,
  options: CareerOptions,
): void {
  const overallByDriverId = new Map(views.overallStandings.map((s) => [s.driver.id, s]));
  const teamPositionByTeamId = new Map(views.teamOverall.map((t) => [t.teamId, t.position]));
  const deltaTeamPositionByTeamId = new Map(views.teamDelta.map((t) => [t.teamId, t.position]));

  classes.forEach((cls, i) => {
    for (const standing of views.classStandings[i]) {
      const driverId = standing.driver.id;
      const extras = views.carTeamStats.get(driverId);
      const ext = views.extendedStats.get(driverId);
      // A driver's teams are sorted by races under each, so [0] is their primary team that season.
      const primaryTeam = extras?.teams[0] ?? null;
      const overallStanding = overallByDriverId.get(driverId);
      // Cars are sorted by races too, so [0] is the most-raced car: the live path's car for every round.
      const rounds = options.withRounds
        ? careerRounds(standing, overallStanding, views.roundTeamCar, {
            teamId: primaryTeam?.teamId ?? null,
            carName: extras?.cars[0]?.carName ?? null,
          })
        : [];

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
        overallPosition: overallStanding?.position ?? null,
        teamPosition: primaryTeam ? (teamPositionByTeamId.get(primaryTeam.teamId) ?? null) : null,
        deltaTeamPosition: primaryTeam ? (deltaTeamPositionByTeamId.get(primaryTeam.teamId) ?? null) : null,
        cars: extras?.cars ?? [],
        teams: extras?.teams ?? [],
        classCounts: countsOf(standing),
        overallCounts: overallCountsOver(standing, overallStanding),
        rounds,
      };

      if (!seasonRowsByDriver.has(driverId)) seasonRowsByDriver.set(driverId, []);
      seasonRowsByDriver.get(driverId)!.push(row);
    }
  });
}

export interface CareerSeasonRows {
  /** driver id -> their season rows. */
  rowsByDriver: Map<string, DriverCareerSeasonRow[]>;
  /** One entry per season computed, in `seasons` order. */
  teamTitles: TeamSeasonTitles[];
}

/** The season rows and team titles of already-built season views (pure; the unit tests' entry point). */
export function seasonCareerRows(
  views: SeasonViews[],
  classes: Lookup[],
  options: CareerOptions = {},
): CareerSeasonRows {
  const rowsByDriver = new Map<string, DriverCareerSeasonRow[]>();
  for (const v of views) addSeasonRows(v, classes, rowsByDriver, options);
  return { rowsByDriver, teamTitles: views.map(teamSeasonTitles) };
}

/** One stored season's rows (pure): the stored path of careerSeasonRows. */
export function storedSeasonCareerRows(
  stats: SeasonRoundStats,
  classes: Lookup[],
  refs: CareerRefs,
  options: CareerOptions = {},
): CareerSeasonRows {
  return seasonCareerRows([storedSeasonViews(stats, classes, refs, options)], classes, options);
}

/** Every driver's season rows over `seasons`: stored where complete, live for the rest. */
async function careerSeasonRows(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionIds: Set<number>,
  refs: CareerRefs,
  status?: Map<string, SeasonStatsStatus>,
  options: CareerOptions = {},
): Promise<CareerSeasonRows> {
  // A career row needs the overall and Delta team positions, and no penalty points.
  const deltaClass = classes.find((c) => c.name === 'Delta');
  const load = await loadStoredSeasons(
    env,
    seasons,
    exhibitionIds,
    { teamCompetitions: ['overall', ...(deltaClass ? [String(deltaClass.id)] : [])], penaltyPoints: false },
    status,
  );
  const views: SeasonViews[] = [];
  for (const season of seasons) {
    const stats = load.stats.get(season.id);
    if (stats) views.push(storedSeasonViews(stats, classes, refs, options));
  }
  if (load.live.length > 0)
    views.push(...(await liveSeasonViews(env, load.live, classes, exhibitionIds, refs)));
  // In `seasons` order, so each driver's rows reach the sort in the order the live path always gave them.
  const order = new Map(seasons.map((s, i) => [s.id, i]));
  views.sort((a, b) => (order.get(a.season.id) ?? 0) - (order.get(b.season.id) ?? 0));
  return seasonCareerRows(views, classes, options);
}

/** Every driver's career plus each season's team competition winners, from one computation. */
export interface CareerData {
  drivers: DriverCareerStats[];
  teamTitles: TeamSeasonTitles[];
}

/**
 * computeDriverCareerStats with the team titles kept, for Compare (BR4.7, BR5.1): the team standings the
 * career rows are built from already hold them, so no extra read is made. Compare passes `withRounds`.
 */
export async function computeCareerData(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>,
  refs?: CareerRefs,
  options: CareerOptions = {},
): Promise<CareerData> {
  const championshipSeasons = seasons.filter((s) => isChampionshipSeason(s.name));
  const [exhibitionIds, careerRefs] = await Promise.all([
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    refs ? Promise.resolve(refs) : loadCareerRefs(env),
  ]);
  const { rowsByDriver, teamTitles } = await careerSeasonRows(
    env,
    championshipSeasons,
    classes,
    exhibitionIds,
    careerRefs,
    undefined,
    options,
  );

  const driverById = new Map(careerRefs.drivers.map((d) => [d.id, d]));
  const out: DriverCareerStats[] = [];
  for (const [driverId, seasonRows] of rowsByDriver) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    seasonRows.sort((a, b) => b.season.number - a.season.number);
    out.push(aggregateDriverCareerStats(driver, seasonRows));
  }

  out.sort((a, b) => displayDriverName(a.driver.name).localeCompare(displayDriverName(b.driver.name)));
  return { drivers: out, teamTitles };
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
  return (await computeCareerData(env, seasons, classes, exhibitionRoundIds, refs)).drivers;
}

/**
 * One driver's career for their profile (BR1.1): the seasons they have stored rows in, plus any season
 * whose stored rows are not current (driverCareerSeasons), read with every driver of those seasons so
 * positions rank as on the standings pages.
 */
export async function computeDriverCareer(
  env: SupabaseEnv,
  driverId: string,
  seasons: Season[],
  classes: Lookup[],
  exhibitionIds: Set<number>,
  refs: CareerRefs,
): Promise<DriverCareerStats | null> {
  const championship = seasons.filter((s) => isChampionshipSeason(s.name));
  const target = await driverCareerSeasons(env, driverId, championship);
  const seasonRows = (
    await careerSeasonRows(env, target.seasons, classes, exhibitionIds, refs, target.status ?? undefined)
  ).rowsByDriver.get(driverId);
  const driver = refs.drivers.find((d) => d.id === driverId);
  if (!driver || !seasonRows) return null;
  seasonRows.sort((a, b) => b.season.number - a.season.number);
  return aggregateDriverCareerStats(driver, seasonRows);
}
