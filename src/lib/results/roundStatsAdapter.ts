/**
 * Turns the database's stored per-round stats (src/lib/db/roundStats.ts) into what the pages show, through
 * the same ranking code as the live path: finalizeStandings, compareStandings, dropWorstRounds and
 * resolveLayout run unchanged; only the per-race accumulation is replaced by a per-round one (BR1.1,
 * BR2.1-BR2.3). A season whose stored rows are incomplete is returned for the live path instead.
 */
import type { SupabaseEnv } from '../db/client';
import type { CarLogo } from '../db/assets';
import type { Circuit, CircuitLayout } from '../db/circuits';
import type { Lookup } from '../db/lookups';
import type { Penalty } from '../db/penalties';
import { resolveSeasonRuleset, type ScoringRuleset, type Season } from '../db/seasons';
import {
  getDriverStoredSeasonIds,
  getRoundStatsForSeasons,
  getRoundStatsStatus,
  type RoundStatsParts,
  type SeasonStatsStatus,
  type RoundDriverStatsRow,
  type RoundPenaltyPointsRow,
  type RoundTeamStatsRow,
} from '../db/roundStats';
import { isChampionshipSeason } from './shared';
import { getRoundsWithLayoutsForSeasons, type RoundWithLayout } from './rounds';
import {
  buildSeasonLogoMap,
  rankedByClassTotal,
  resolveTeamLogo,
  type DriverBasic,
  type TeamBasic,
} from './rows';
import {
  buildPenaltiesByDriverAndRound,
  finalizeStandings,
  findFinalRoundSubsessionId,
  newStandingsAccum,
  roundStatFor,
  rulesetBaseDropWeeks,
  summarizePenalty,
  type DriverSeasonStanding,
  type SeasonStandingsRoundColumn,
  type StandingsAccum,
  type StandingsRoundCell,
} from './standingsCore';
import { resolveLayout } from './layouts';
import type { TeamSeasonStanding } from './teamStandings';
import type { DriverCarStat, DriverSeasonExtras, DriverTeamStat } from './seasonCarTeam';
import type { DriverSeasonExtendedStats, ExtendedRoundStat } from './extendedStats';

/** One season's stored stats as the builders read them: excluded (exhibition and test) rounds removed. */
export interface SeasonRoundStats {
  season: Season;
  /** Every curated_rounds row of the season with its layout, excluded rounds included, newest first. */
  rounds: RoundWithLayout[];
  excludedIds: Set<number>;
  driverRows: RoundDriverStatsRow[];
  teamRows: RoundTeamStatsRow[];
  penaltyRows: RoundPenaltyPointsRow[];
}

/** One season's slice of rows read for several seasons, with the excluded rounds dropped. */
export function seasonRoundStatsFrom(
  season: Season,
  rounds: RoundWithLayout[],
  excludedIds: Set<number>,
  stored: {
    driverRows: RoundDriverStatsRow[];
    teamRows: RoundTeamStatsRow[];
    penaltyRows: RoundPenaltyPointsRow[];
  },
): SeasonRoundStats {
  const keep = (r: { season_id: string; subsession_id: number }) =>
    r.season_id === season.id && !excludedIds.has(r.subsession_id);
  return {
    season,
    rounds: rounds.filter((r) => r.season_id === season.id),
    excludedIds,
    driverRows: stored.driverRows.filter(keep).sort(byRoundThenDriver),
    teamRows: stored.teamRows.filter(keep),
    penaltyRows: stored.penaltyRows.filter(keep),
  };
}

function byRoundThenDriver(a: RoundDriverStatsRow, b: RoundDriverStatsRow): number {
  return (
    a.subsession_id - b.subsession_id || (a.driver_id < b.driver_id ? -1 : a.driver_id > b.driver_id ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------------------------------------
// Driver standings
// ---------------------------------------------------------------------------------------------------------

export interface StandingsRefs {
  drivers: DriverBasic[];
  rulesets: ScoringRuleset[];
  classes: Lookup[];
  /** The season's penalties, only for the Matrix cell summaries; omit where no Matrix is shown. */
  penalties?: Penalty[];
}

interface RoundCounts {
  points: number;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  pole: boolean;
}

function addRound(
  accum: Map<string, StandingsAccum>,
  row: RoundDriverStatsRow,
  counts: RoundCounts,
): StandingsAccum {
  let a = accum.get(row.driver_id);
  if (!a) {
    a = newStandingsAccum();
    accum.set(row.driver_id, a);
  }
  const id = row.subsession_id;
  a.starts += row.starts;
  a.subsessionIds.add(id);
  const rs = roundStatFor(a, id);
  rs.starts += row.starts;
  a.wins += counts.wins;
  a.podiums += counts.podiums;
  a.top5s += counts.top5s;
  a.top10s += counts.top10s;
  rs.wins += counts.wins;
  rs.podiums += counts.podiums;
  rs.top5s += counts.top5s;
  rs.top10s += counts.top10s;
  if (counts.pole) a.poleSubsessionIds.add(id);
  rs.poles = a.poleSubsessionIds.has(id) ? 1 : 0;
  a.lapsLed += row.laps_led;
  a.laps += row.laps;
  rs.lapsLed += row.laps_led;
  rs.laps += row.laps;
  a.roundPoints.set(id, (a.roundPoints.get(id) ?? 0) + counts.points);
  return a;
}

function finishStandings(
  stats: SeasonRoundStats,
  accum: Map<string, StandingsAccum>,
  pool: Set<number>,
  refs: StandingsRefs,
): DriverSeasonStanding[] {
  const ruleset = resolveSeasonRuleset(stats.season, refs.rulesets);
  return finalizeStandings(
    accum,
    new Map(refs.drivers.map((d) => [d.id, d])),
    stats.season,
    pool,
    findFinalRoundSubsessionId(stats.rounds, stats.excludedIds),
    // Protected (false) when no ruleset resolves, as buildSeasonStandings.
    ruleset?.can_drop_final_round ?? false,
    rulesetBaseDropWeeks(ruleset),
    buildPenaltiesByDriverAndRound(refs.penalties ?? []),
  );
}

/**
 * One class's standings. Points are class_points for Gamma and Delta and overall_points for Alpha (BR2.6);
 * wins, podiums and top 5s and 10s use the class columns; poles are the overall pole for Alpha, which never
 * earns a class pole, and the class pole otherwise.
 */
export function classStandingsFromRounds(
  stats: SeasonRoundStats,
  classId: number,
  refs: StandingsRefs,
): DriverSeasonStanding[] {
  if (!isChampionshipSeason(stats.season.name)) return [];
  const className = refs.classes.find((c) => c.id === classId)?.name;
  const classTotal = rankedByClassTotal(className);
  const isAlpha = className === 'Alpha';
  const rows = stats.driverRows.filter((r) => r.class_id === classId);
  if (rows.length === 0) return [];
  const accum = new Map<string, StandingsAccum>();
  for (const r of rows) {
    addRound(accum, r, {
      points: classTotal ? r.class_points : r.overall_points,
      wins: r.class_wins,
      podiums: r.class_podiums,
      top5s: r.class_top5s,
      top10s: r.class_top10s,
      pole: isAlpha ? r.overall_pole : r.class_pole,
    });
  }
  return finishStandings(stats, accum, new Set(rows.map((r) => r.subsession_id)), refs);
}

/** Every class in one table: overall_points, the overall columns and the true overall pole. */
export function overallStandingsFromRounds(
  stats: SeasonRoundStats,
  refs: StandingsRefs,
): DriverSeasonStanding[] {
  if (!isChampionshipSeason(stats.season.name)) return [];
  if (stats.driverRows.length === 0) return [];
  const accum = new Map<string, StandingsAccum>();
  for (const r of stats.driverRows) {
    const a = addRound(accum, r, {
      points: r.overall_points,
      wins: r.overall_wins,
      podiums: r.overall_podiums,
      top5s: r.overall_top5s,
      top10s: r.overall_top10s,
      pole: r.overall_pole,
    });
    a.classId = r.class_id;
  }
  return finishStandings(stats, accum, new Set(stats.driverRows.map((r) => r.subsession_id)), refs);
}

// ---------------------------------------------------------------------------------------------------------
// Team standings
// ---------------------------------------------------------------------------------------------------------

export interface TeamRefs {
  teams: TeamBasic[];
  seasonLogoRows: { team_id: string; season_id: string; logo_url: string }[];
  /** As StandingsRefs.penalties. */
  penalties?: Penalty[];
}

/** The class competitions round_team_stats holds besides 'overall'. Any other class falls back to live. */
export const STORED_TEAM_CLASSES = ['Alpha', 'Delta'];

/** Whether this team competition (undefined = overall) is stored. */
export function isStoredTeamCompetition(classId: number | undefined, classes: Lookup[]): boolean {
  if (classId === undefined) return true;
  const name = classes.find((c) => c.id === classId)?.name;
  return name !== undefined && STORED_TEAM_CLASSES.includes(name);
}

/**
 * Team standings from round_team_stats: `classId` undefined is the overall competition, otherwise that
 * class's own. Every round counts. `raceEntries` stay empty: only the Teams view lists them, and it keeps
 * the live per-race path.
 */
export function teamStandingsFromRounds(
  stats: SeasonRoundStats,
  classId: number | undefined,
  refs: TeamRefs,
): TeamSeasonStanding[] {
  if (!isChampionshipSeason(stats.season.name)) return [];
  const competition = classId === undefined ? 'overall' : String(classId);
  const rows = stats.teamRows.filter((t) => t.competition === competition);
  if (rows.length === 0) return [];

  const teamById = new Map(refs.teams.map((t) => [t.id, t]));
  const seasonLogoMap = buildSeasonLogoMap(refs.seasonLogoRows);
  const penaltiesByDriverAndRound = buildPenaltiesByDriverAndRound(refs.penalties ?? []);

  const driverIdsByTeam = new Map<string, Set<string>>();
  for (const r of stats.driverRows) {
    if (!r.team_id || (classId !== undefined && r.class_id !== classId)) continue;
    if (!driverIdsByTeam.has(r.team_id)) driverIdsByTeam.set(r.team_id, new Set());
    driverIdsByTeam.get(r.team_id)!.add(r.driver_id);
  }

  interface TeamAccum {
    starts: number;
    roundPoints: Map<number, number>;
    roundStarts: Map<number, number>;
  }
  const accum = new Map<string, TeamAccum>();
  for (const t of [...rows].sort((a, b) => a.subsession_id - b.subsession_id)) {
    let a = accum.get(t.team_id);
    if (!a) {
      a = { starts: 0, roundPoints: new Map(), roundStarts: new Map() };
      accum.set(t.team_id, a);
    }
    a.starts += t.starts;
    a.roundStarts.set(t.subsession_id, (a.roundStarts.get(t.subsession_id) ?? 0) + t.starts);
    a.roundPoints.set(t.subsession_id, (a.roundPoints.get(t.subsession_id) ?? 0) + t.points);
  }

  const standings: Omit<TeamSeasonStanding, 'position'>[] = [];
  for (const [teamId, a] of accum) {
    const team = teamById.get(teamId);
    if (!team) continue; // team record deleted: skipped, as the live path does
    const driverIds = [...(driverIdsByTeam.get(teamId) ?? [])];
    const roundCells = new Map<number, StandingsRoundCell>();
    for (const [subsessionId, points] of a.roundPoints) {
      const penalties = driverIds.flatMap((driverId) =>
        (penaltiesByDriverAndRound.get(driverId)?.get(subsessionId) ?? []).map(summarizePenalty),
      );
      roundCells.set(subsessionId, { points, dropped: false, penalties });
    }
    standings.push({
      teamId,
      teamName: team.name,
      logoUrl: resolveTeamLogo(team, stats.season.id, seasonLogoMap),
      totalPoints: [...a.roundPoints.values()].reduce((sum, p) => sum + p, 0),
      starts: a.starts,
      appearances: a.roundPoints.size,
      driverIds,
      roundCells,
      roundStarts: a.roundStarts,
      raceEntries: [],
    });
  }
  standings.sort((a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName));
  return standings.map((s, i) => ({ ...s, position: i + 1 }));
}

// ---------------------------------------------------------------------------------------------------------
// Cars and teams per driver
// ---------------------------------------------------------------------------------------------------------

export interface CarTeamRefs {
  teams: TeamBasic[];
  carLogos: CarLogo[];
  seasonLogoRows: { team_id: string; season_id: string; logo_url: string }[];
}

/**
 * Each driver's cars and teams for the season, summed over the stored rounds. A driver's primary team
 * (teams[0]) is the one with the most races under it; a tie goes to the lower team_id.
 */
export function carTeamStatsFromRounds(
  stats: SeasonRoundStats,
  refs: CarTeamRefs,
): Map<string, DriverSeasonExtras> {
  const teamById = new Map(refs.teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(refs.carLogos.map((c) => [c.car_name, c.logo_url]));
  const seasonLogoMap = buildSeasonLogoMap(refs.seasonLogoRows);

  const carsByDriver = new Map<string, Map<string, number>>();
  const teamsByDriver = new Map<string, Map<string, { under: number; scored: number }>>();
  for (const r of stats.driverRows) {
    for (const [carName, races] of Object.entries(r.cars ?? {})) {
      if (!carName || !(races > 0)) continue;
      if (!carsByDriver.has(r.driver_id)) carsByDriver.set(r.driver_id, new Map());
      const m = carsByDriver.get(r.driver_id)!;
      m.set(carName, (m.get(carName) ?? 0) + races);
    }
    if (r.team_id && r.races_under_team > 0) {
      if (!teamsByDriver.has(r.driver_id)) teamsByDriver.set(r.driver_id, new Map());
      const m = teamsByDriver.get(r.driver_id)!;
      const t = m.get(r.team_id) ?? { under: 0, scored: 0 };
      t.under += r.races_under_team;
      t.scored += r.races_scored_for_team;
      m.set(r.team_id, t);
    }
  }

  const out = new Map<string, DriverSeasonExtras>();
  for (const driverId of new Set([...carsByDriver.keys(), ...teamsByDriver.keys()])) {
    const cars: DriverCarStat[] = [...(carsByDriver.get(driverId)?.entries() ?? [])]
      .map(([carName, races]) => ({ carName, logoUrl: carLogoByName.get(carName) ?? null, races }))
      .sort((a, b) => b.races - a.races);
    const teams: DriverTeamStat[] = [...(teamsByDriver.get(driverId)?.entries() ?? [])]
      .map(([teamId, t]) => {
        const team = teamById.get(teamId);
        return {
          teamId,
          teamName: team?.name ?? 'Unknown Team',
          logoUrl: team ? resolveTeamLogo(team, stats.season.id, seasonLogoMap) : null,
          racesUnderTeam: t.under,
          racesScoredForTeam: t.scored,
        };
      })
      .sort(
        (a, b) =>
          b.racesUnderTeam - a.racesUnderTeam || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0),
      );
    out.set(driverId, { cars, teams });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Extended stats (the standings driver panel and the slider's detail columns)
// ---------------------------------------------------------------------------------------------------------

export interface LayoutRefs {
  circuits: Circuit[];
  layouts: CircuitLayout[];
}

/** subsession_id -> the round's resolved layout length and corner count (null when it doesn't resolve). */
export function roundLayoutFigures(
  stats: SeasonRoundStats,
  refs: LayoutRefs,
): { km: Map<number, number | null>; corners: Map<number, number | null> } {
  const roundById = new Map(stats.rounds.map((r) => [r.subsession_id, r]));
  const km = new Map<number, number | null>();
  const corners = new Map<number, number | null>();
  for (const id of new Set(stats.driverRows.map((r) => r.subsession_id))) {
    const round = roundById.get(id);
    const layout = round?.track_name
      ? resolveLayout(round.track_name, round.layout ?? null, refs.circuits, refs.layouts)
      : null;
    km.set(id, layout?.length_km ?? null);
    corners.set(id, layout?.corners ?? null);
  }
  return { km, corners };
}

/**
 * Per-driver season totals for the standings panel, as getSeasonDriverExtendedStats. Distance sums laps x
 * whole metres, so a round's total equals the sum of its races. Penalty points come from
 * round_penalty_points, so a driver penalised without a score row still gets them.
 */
export function extendedStatsFromRounds(
  stats: SeasonRoundStats,
  refs: LayoutRefs,
): Map<string, DriverSeasonExtendedStats> {
  if (!isChampionshipSeason(stats.season.name) || stats.driverRows.length === 0) return new Map();
  const { km: kmByRound, corners: cornersByRound } = roundLayoutFigures(stats, refs);

  interface ExtendedAccum {
    laps: number;
    lapsLed: number;
    netPositionsChange: number;
    incidents: number;
    penaltyPoints: number;
    bonusPoints: number;
    distanceMetres: number;
    totalCorners: number;
    anyKm: boolean;
    anyCorners: boolean;
    byRound: Map<number, ExtendedRoundStat>;
  }
  const accum = new Map<string, ExtendedAccum>();
  const accumFor = (driverId: string): ExtendedAccum => {
    let a = accum.get(driverId);
    if (!a) {
      a = {
        laps: 0,
        lapsLed: 0,
        netPositionsChange: 0,
        incidents: 0,
        penaltyPoints: 0,
        bonusPoints: 0,
        distanceMetres: 0,
        totalCorners: 0,
        anyKm: false,
        anyCorners: false,
        byRound: new Map(),
      };
      accum.set(driverId, a);
    }
    return a;
  };
  const roundFor = (a: ExtendedAccum, id: number): ExtendedRoundStat => {
    let r = a.byRound.get(id);
    if (!r) {
      r = {
        laps: 0,
        lapsLed: 0,
        netPositionsChange: 0,
        incidents: 0,
        penaltyPoints: 0,
        bonusPoints: 0,
        km: kmByRound.get(id) ?? null,
        corners: cornersByRound.get(id) ?? null,
      };
      a.byRound.set(id, r);
    }
    return r;
  };

  for (const row of stats.driverRows) {
    const a = accumFor(row.driver_id);
    const r = roundFor(a, row.subsession_id);
    a.bonusPoints += row.bonus_points;
    r.bonusPoints += row.bonus_points;
    a.laps += row.laps;
    a.lapsLed += row.laps_led;
    a.incidents += row.incidents;
    a.netPositionsChange += row.net_positions;
    r.laps += row.laps;
    r.lapsLed += row.laps_led;
    r.incidents += row.incidents;
    r.netPositionsChange += row.net_positions;
    const km = kmByRound.get(row.subsession_id);
    if (km !== null && km !== undefined) {
      a.anyKm = true;
      a.distanceMetres += row.laps * Math.round(km * 1000);
    }
    const corners = cornersByRound.get(row.subsession_id);
    if (corners !== null && corners !== undefined) {
      a.anyCorners = true;
      a.totalCorners += row.laps * corners;
    }
  }
  for (const p of stats.penaltyRows) {
    const a = accumFor(p.driver_id);
    a.penaltyPoints += p.penalty_points;
    roundFor(a, p.subsession_id).penaltyPoints += p.penalty_points;
  }

  const out = new Map<string, DriverSeasonExtendedStats>();
  for (const [driverId, a] of accum) {
    out.set(driverId, {
      laps: a.laps,
      lapsLed: a.lapsLed,
      netPositionsChange: a.netPositionsChange,
      incidents: a.incidents,
      incidentsPerLap: a.laps > 0 ? a.incidents / a.laps : null,
      penaltyPoints: a.penaltyPoints,
      bonusPoints: a.bonusPoints,
      distanceKm: a.anyKm ? a.distanceMetres / 1000 : null,
      cornersPerIncident: a.anyCorners && a.incidents > 0 ? a.totalCorners / a.incidents : null,
      totalCorners: a.anyCorners ? a.totalCorners : null,
      byRound: a.byRound,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Pools, columns and denominators
// ---------------------------------------------------------------------------------------------------------

/** The rounds a view's Matrix and slider show: the class's rounds, or every round for the overall view. */
export function viewSubsessionIds(stats: SeasonRoundStats, classId: number | undefined): Set<number> {
  const rows =
    classId === undefined ? stats.driverRows : stats.driverRows.filter((r) => r.class_id === classId);
  return new Set(rows.map((r) => r.subsession_id));
}

/** subsession_id -> races in the round: the most starts any one driver made there. */
export function racesPerRound(stats: SeasonRoundStats): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of stats.driverRows)
    out.set(r.subsession_id, Math.max(out.get(r.subsession_id) ?? 0, r.starts));
  return out;
}

export interface SeasonDenominators {
  /** Races the whole season has run, every class. */
  maxStarts: number;
  /** Rounds the whole season has run. */
  maxAppearances: number;
  /** As of each column: races and rounds run through that round's start time. */
  colDenoms: { s: number; a: number }[];
}

/** The "x of y" Starts and Apps denominators, season-wide and as of each Matrix column. */
export function seasonDenominators(
  stats: SeasonRoundStats,
  columns: SeasonStandingsRoundColumn[],
): SeasonDenominators {
  const races = racesPerRound(stats);
  const startTime = new Map(stats.rounds.map((r) => [r.subsession_id, r.start_time]));
  const list = [...races].map(([id, n]) => ({ t: startTime.get(id) ?? '', races: n }));
  return {
    maxStarts: list.reduce((sum, r) => sum + r.races, 0),
    maxAppearances: list.length,
    colDenoms: columns.map((col) => {
      const through = list.filter((r) => r.t <= col.startTime);
      return { s: through.reduce((sum, r) => sum + r.races, 0), a: through.length };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Loading, with the completeness fallback
// ---------------------------------------------------------------------------------------------------------

export interface StoredSeasonsLoad {
  /** Seasons whose stored rows the database reports current, ready for the builders above. */
  stats: Map<string, SeasonRoundStats>;
  /** Seasons this render computes on the live path instead. */
  live: Season[];
}

/**
 * Reads these seasons' stored rows and rounds and asks round_stats_status (one call for every season) in
 * one parallel stage. A season that is not current is logged with the database's reason and computed on
 * the live path for this render; a failed status call or read sends every season there, so pages never
 * show stale numbers. `status` reuses an answer the caller already has for these seasons.
 */
export async function loadStoredSeasons(
  env: SupabaseEnv,
  seasons: Season[],
  excludedIds: Set<number>,
  /** The team competitions and penalty points the page shows; everything when omitted. */
  parts: RoundStatsParts = {},
  status?: Map<string, SeasonStatsStatus>,
): Promise<StoredSeasonsLoad> {
  if (seasons.length === 0) return { stats: new Map(), live: [] };
  const ids = seasons.map((s) => s.id);
  try {
    const [statusBySeason, stored, rounds] = await Promise.all([
      status ? Promise.resolve(status) : getRoundStatsStatus(env, ids),
      getRoundStatsForSeasons(env, ids, parts),
      getRoundsWithLayoutsForSeasons(env, ids),
    ]);
    const stats = new Map<string, SeasonRoundStats>();
    const live: Season[] = [];
    for (const season of seasons) {
      const s = statusBySeason.get(season.id);
      if (s?.current) {
        stats.set(season.id, seasonRoundStatsFrom(season, rounds, excludedIds, stored));
      } else {
        console.warn(`round stats incomplete: season ${season.name} (${s?.reason ?? 'no status'})`);
        live.push(season);
      }
    }
    return { stats, live };
  } catch (err) {
    console.error(
      'Failed to read the stored round stats or their status; this render uses the live path:',
      err,
    );
    return { stats: new Map(), live: seasons };
  }
}

/**
 * The seasons a driver profile computes (BR1.1): those the driver has stored rows in, plus every season
 * the database reports not current, where the stored rows can't say whether the driver raced (before the
 * backfill, that is every season, so a profile is never empty). A failed read returns every season. The
 * status answer is returned for loadStoredSeasons to reuse.
 */
export async function driverCareerSeasons(
  env: SupabaseEnv,
  driverId: string,
  seasons: Season[],
): Promise<{ seasons: Season[]; status: Map<string, SeasonStatsStatus> | null }> {
  if (seasons.length === 0) return { seasons, status: null };
  try {
    const [storedSeasonIds, status] = await Promise.all([
      getDriverStoredSeasonIds(env, driverId),
      getRoundStatsStatus(
        env,
        seasons.map((s) => s.id),
      ),
    ]);
    return {
      seasons: seasons.filter((s) => storedSeasonIds.has(s.id) || status.get(s.id)?.current !== true),
      status,
    };
  } catch (err) {
    console.error("Failed to read the driver's stored seasons; using every championship season:", err);
    return { seasons, status: null };
  }
}
