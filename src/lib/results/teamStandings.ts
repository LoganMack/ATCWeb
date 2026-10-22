import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import type { Season } from '../db/seasons';
import { getDriverClasses, type Lookup } from '../db/lookups';
import { isChampionshipSeason } from './shared';
import {
  driversSelect,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  buildSeasonLogoMap,
  resultKey,
  getRaceScoresForSeasonClass,
  rankedByClassTotal,
  resolveTeamLogo,
  seasonPointsOf,
  type DriverBasic,
  type TeamBasic,
  type ScoreRow,
} from './rows';
import { getSeasonOverallContext, type SeasonOverallContext } from './seasonContext';
import { buildPenaltiesByDriverAndRound, summarizePenalty, type StandingsRoundCell } from './standingsCore';
import { topTeamScorers } from './seasonCarTeam';

export interface TeamSeasonStanding {
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  position: number;
  totalPoints: number;
  /** Every race any of this team's drivers started this season — not just races they were one of the top 2 scorers in. */
  starts: number;
  /** Distinct rounds (subsession_ids) this team had at least one driver in. */
  appearances: number;
  /** Every driver who raced for this team this season, at least once — used to build the team-standings page's expandable roster detail (overall championship position/points/starts come from `computeOverallSeasonStandings`, joined in at the page level). */
  driverIds: string[];
  /** Standings page's "Matrix" view — see DriverSeasonStanding.roundCells' own doc comment. `dropped` is always false here — teams never drop rounds (see this function's own doc comment on why). `penalties` pools every penalty logged against any driver who ever raced for this team this season, which can very occasionally over-flag a round for a team a penalized driver had already left by then (driverIds isn't tracked per-round) — acceptable slop for a purely informational summary. */
  roundCells: Map<number, StandingsRoundCell>;
  /** Races any of this team's drivers started, per round — feeds the "Standings by Round" slider's as-of Starts column. */
  roundStarts: Map<number, number>;
  /** Every finish by any of this team's drivers this season, one per driver per race — the Team Standings expandable row's results table. `counted` is false for a finish outside the team's top 2 scorers of that race (it earned the team nothing). */
  raceEntries: TeamRaceEntry[];
}

/** One driver's finish in one race, as listed in a team's expandable row on the Team Standings page. */
export interface TeamRaceEntry {
  subsessionId: number;
  raceNumber: number;
  driverId: string;
  /** Null for the per-class (Delta) team competition, which doesn't tag classes. */
  classId: number | null;
  /** Overall field position (penalty-adjusted), or the class position in a per-class team competition. Null for a disqualified driver. */
  position: number | null;
  dsq: boolean;
  startingPosition: number | null;
  incidents: number | null;
  laps: number | null;
  lapsLed: number | null;
  bestLapTenThousandths: number | null;
  /** The points figure the team competition ranked this finish by. */
  points: number;
  /** True when this finish was one of the team's top 2 scorers of the race, i.e. its points went into the team's total. */
  counted: boolean;
}

/**
 * Final team standings for one season. Every round counts: drop weeks apply only to the driver championships
 * (Logan). A team's round points are its top 2 drivers' (topTeamScorers()).
 * - `classId` omitted: the overall competition by `overall_total`, so Gamma/Delta class points give no team
 *   an edge.
 * - `classId` set: that class's own team competition, scored like its driver championship (class_total for
 *   Gamma and Delta, overall_total for Alpha; BR2.6).
 */
export async function computeTeamSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>,
  classId?: number,
  driversBasic?: DriverBasic[],
  teamsBasic?: TeamBasic[],
  /** Rows from `getAllTeamSeasonLogosSafe` — see `computeSeasonStandings`' `precomputedOverallContext` param for why sharing these matters (`computeDriverCareerStats` calls this twice per season, overall + Delta). */
  seasonLogoRowsParam?: { team_id: string; season_id: string; logo_url: string }[],
  classesLookup?: Lookup[],
  precomputedOverallContext?: SeasonOverallContext,
  /** Only meaningful for the per-class branch (`classId` set) — see `computeSeasonStandings`' identical param. */
  precomputedScoresRaw?: ScoreRow[],
): Promise<TeamSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [drivers, exhibitionIds, teams, seasonLogoRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    teamsBasic ? Promise.resolve(teamsBasic) : getTeamsBasic(env),
    seasonLogoRowsParam ? Promise.resolve(seasonLogoRowsParam) : getAllTeamSeasonLogosSafe(env),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);
  // Fetched once before the branch so the Matrix penalty summaries can use it too.
  const overallContext =
    precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  const penaltiesByDriverAndRound = buildPenaltiesByDriverAndRound(overallContext.penalties);

  interface TeamAccum {
    starts: number;
    subsessionIds: Set<number>;
    roundPoints: Map<number, number>;
    roundStarts: Map<number, number>;
    driverIds: Set<string>;
    raceEntries: TeamRaceEntry[];
  }
  const accum = new Map<string, TeamAccum>();
  function getAccum(teamId: string): TeamAccum {
    let a = accum.get(teamId);
    if (!a) {
      a = {
        starts: 0,
        subsessionIds: new Set(),
        roundPoints: new Map(),
        roundStarts: new Map(),
        driverIds: new Set(),
        raceEntries: [],
      };
      accum.set(teamId, a);
    }
    return a;
  }

  if (classId === undefined) {
    // ---- Overall (cross-class) team competition ----
    const scores = overallContext.overallScores;
    if (scores.length === 0) return [];

    const pointsOf = (s: ScoreRow) => s.overall_total;

    // Starts/appearances count every row for the team, same as a driver's
    // own starts/appearances — only the POINTS below are limited to the top 2.
    const raceTeamGroups = new Map<string, ScoreRow[]>(); // "subsession:race:team" -> that team's rows for that race
    for (const s of scores) {
      if (!s.team_id) continue;
      const a = getAccum(s.team_id);
      a.starts += 1;
      a.roundStarts.set(s.subsession_id, (a.roundStarts.get(s.subsession_id) ?? 0) + 1);
      a.subsessionIds.add(s.subsession_id);
      a.driverIds.add(s.driver_id);

      const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
      if (!raceTeamGroups.has(key)) raceTeamGroups.set(key, []);
      raceTeamGroups.get(key)!.push(s);
    }

    for (const group of raceTeamGroups.values()) {
      const subsessionId = group[0].subsession_id;
      const teamId = group[0].team_id as string;
      const scorers = topTeamScorers(group, pointsOf);
      const roundSum = scorers.reduce((sum, s) => sum + pointsOf(s), 0);
      const a = getAccum(teamId);
      a.roundPoints.set(subsessionId, (a.roundPoints.get(subsessionId) ?? 0) + roundSum);
      for (const s of group) {
        const custId = overallContext.custIdByDriverId.get(s.driver_id);
        const resultLookupKey = custId != null ? resultKey(s.subsession_id, s.race_number, custId) : null;
        const raw = resultLookupKey ? overallContext.rawByKey.get(resultLookupKey) : undefined;
        const lapStats = resultLookupKey ? overallContext.lapStatsByKey.get(resultLookupKey) : undefined;
        a.raceEntries.push({
          subsessionId: s.subsession_id,
          raceNumber: s.race_number,
          driverId: s.driver_id,
          classId: s.class_id,
          position: s.dsq ? null : s.position,
          dsq: s.dsq,
          startingPosition: raw?.starting_position ?? null,
          incidents: raw?.incidents ?? null,
          laps: raw?.laps_complete ?? null,
          lapsLed: raw?.laps_led ?? null,
          bestLapTenThousandths: lapStats?.best_lap_ten_thousandths ?? null,
          points: pointsOf(s),
          counted: scorers.includes(s),
        });
      }
    }
  } else {
    // ---- One class's own separate team competition (e.g. Delta's) ----
    const [scoresRaw, classes] = await Promise.all([
      precomputedScoresRaw
        ? Promise.resolve(precomputedScoresRaw)
        : getRaceScoresForSeasonClass(env, season.id, classId),
      classesLookup ? Promise.resolve(classesLookup) : getDriverClasses(env),
    ]);
    const classTotal = rankedByClassTotal(classes.find((c) => c.id === classId)?.name);
    const scores =
      exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
    if (scores.length === 0) return [];

    const custIdByDriverId = new Map(
      drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
    );
    const rawByKey = overallContext.rawByKey;
    const pointsOf = (s: ScoreRow) => seasonPointsOf(s, classTotal);

    const raceTeamGroups = new Map<string, ScoreRow[]>();
    for (const s of scores) {
      if (!s.team_id) continue;
      const a = getAccum(s.team_id);
      a.starts += 1;
      a.roundStarts.set(s.subsession_id, (a.roundStarts.get(s.subsession_id) ?? 0) + 1);
      a.subsessionIds.add(s.subsession_id);
      a.driverIds.add(s.driver_id);

      const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
      if (!raceTeamGroups.has(key)) raceTeamGroups.set(key, []);
      raceTeamGroups.get(key)!.push(s);
    }

    for (const group of raceTeamGroups.values()) {
      const subsessionId = group[0].subsession_id;
      const teamId = group[0].team_id as string;
      const scorers = topTeamScorers(group, pointsOf);
      const roundSum = scorers.reduce((sum, s) => sum + pointsOf(s), 0);
      const a = getAccum(teamId);
      a.roundPoints.set(subsessionId, (a.roundPoints.get(subsessionId) ?? 0) + roundSum);
      for (const s of group) {
        const custId = custIdByDriverId.get(s.driver_id);
        const resultLookupKey = custId != null ? resultKey(s.subsession_id, s.race_number, custId) : null;
        const raw = resultLookupKey ? rawByKey.get(resultLookupKey) : undefined;
        const lapStats = resultLookupKey ? overallContext.lapStatsByKey.get(resultLookupKey) : undefined;
        a.raceEntries.push({
          subsessionId: s.subsession_id,
          raceNumber: s.race_number,
          driverId: s.driver_id,
          classId: null,
          position: s.dsq ? null : s.class_position,
          dsq: s.dsq,
          startingPosition: raw?.starting_position ?? null,
          incidents: raw?.incidents ?? null,
          laps: raw?.laps_complete ?? null,
          lapsLed: raw?.laps_led ?? null,
          bestLapTenThousandths: lapStats?.best_lap_ten_thousandths ?? null,
          points: pointsOf(s),
          counted: scorers.includes(s),
        });
      }
    }
  }

  // The team championship drops no rounds; drop weeks are for drivers only (Logan).
  const standings: Omit<TeamSeasonStanding, 'position'>[] = [];
  for (const [teamId, a] of accum) {
    const team = teamById.get(teamId);
    if (!team) continue; // team record deleted/missing — skip rather than crash the page

    const totalPoints = [...a.roundPoints.values()].reduce((sum, p) => sum + p, 0);

    // Matrix cells as for drivers, but never dropped, and pooling every roster driver's penalties for the
    // round.
    const roundCells = new Map<number, StandingsRoundCell>();
    for (const [subsessionId, points] of a.roundPoints) {
      const penalties = [...a.driverIds].flatMap((driverId) =>
        (penaltiesByDriverAndRound.get(driverId)?.get(subsessionId) ?? []).map(summarizePenalty),
      );
      roundCells.set(subsessionId, { points, dropped: false, penalties });
    }

    standings.push({
      teamId,
      teamName: team.name,
      logoUrl: resolveTeamLogo(team, season.id, seasonLogoMap),
      totalPoints,
      starts: a.starts,
      appearances: a.subsessionIds.size,
      driverIds: [...a.driverIds],
      roundCells,
      roundStarts: a.roundStarts,
      raceEntries: a.raceEntries,
    });
  }

  standings.sort((a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName));
  return standings.map((s, i) => ({ ...s, position: i + 1 }));
}
