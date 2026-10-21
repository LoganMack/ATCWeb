import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getCarLogos, type CarLogo } from '../db/assets';
import type { Season } from '../db/seasons';
import {
  driversSelect,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  resultKey,
  getRaceScoresForSeasonOverall,
  getCuratedRaceResultsForSubsessions,
  buildSeasonLogoMap,
  resolveTeamLogo,
  type DriverBasic,
  type TeamBasic,
  type RaceScoreOverallRow,
} from './rows';
import type { SeasonOverallContext } from './seasonContext';

// ---------------------------------------------------------------------------
// Per-driver car/team usage for a season — powers the small logo rows on
// the standings page (see src/pages/standings.astro).
// ---------------------------------------------------------------------------

export interface DriverCarStat {
  carName: string;
  logoUrl: string | null;
  races: number;
}

export interface DriverTeamStat {
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  /** How many races this driver raced under this team, this season. */
  racesUnderTeam: number;
  /**
   * How many of those races this driver was one of the team's top 2 point
   * scorers in (the rule that decides which drivers' points actually count
   * toward the team championship for that race).
   */
  racesScoredForTeam: number;
}

export interface DriverSeasonExtras {
  cars: DriverCarStat[];
  teams: DriverTeamStat[];
}

/**
 * Ranks same-team, same-race rows by points and keeps just the top 2 —
 * Logan's team championship rule: "only the top 2 scoring drivers for each
 * team add their points to the team championship per race." The single
 * source of truth for this rule; every place that needs "who scored for
 * this team this race" (season car/team usage stats, the news recap's team
 * breakdown, Team Standings) calls this instead of re-deriving it.
 *
 * `pointsOf` lets each caller pick which points figure to rank (and
 * presumably then sum) by — the cross-class "overall" team competition
 * uses the class-blind formula (finish + finesse + pole + deduction,
 * matching `computeOverallSeasonStandings`' own formula), while a single
 * class's own team competition (e.g. Delta's) wants that class's full
 * total, class_points bonus included.
 */
export function topTeamScorers<T>(rows: T[], pointsOf: (row: T) => number): T[] {
  return [...rows].sort((a, b) => pointsOf(b) - pointsOf(a)).slice(0, 2);
}

/**
 * Per-driver "which cars/teams did they use this season, how often" —
 * computed once for the whole season (every class, regardless of which
 * standings view — overall or per-class — is actually being shown), since
 * a driver's car/team usage isn't itself a per-class-view concern.
 *
 * Team `racesScoredForTeam` implements `topTeamScorers()`'s rule (see its
 * own doc comment) for every (race, team) group.
 */
export async function getSeasonCarTeamStats(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>,
  driversBasic?: DriverBasic[],
  teamsBasic?: TeamBasic[],
  carLogosLookup?: CarLogo[],
  seasonLogoRowsParam?: { team_id: string; season_id: string; logo_url: string }[],
  /**
   * When given, skips this function's own race_scores/curated_race_results
   * fetches entirely and reuses this season-wide context's
   * `overallScores`/`rawByKey` instead — see `computeSeasonStandings`'
   * identical param. Omit it (every existing single-season caller does) and
   * this function fetches its own smaller, cheaper pair of queries exactly
   * as before; pulling in the FULL context (penalties, lap stats,
   * curated_rounds) unconditionally would cost those callers MORE, not
   * less, since this function doesn't use any of that extra data itself.
   */
  precomputedOverallContext?: SeasonOverallContext,
): Promise<Map<string, DriverSeasonExtras>> {
  const [drivers, teams, carLogos, exhibitionIds, seasonLogoRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    teamsBasic ? Promise.resolve(teamsBasic) : getTeamsBasic(env),
    carLogosLookup ? Promise.resolve(carLogosLookup) : getCarLogos(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
    seasonLogoRowsParam ? Promise.resolve(seasonLogoRowsParam) : getAllTeamSeasonLogosSafe(env),
  ]);

  let scores: RaceScoreOverallRow[];
  let carNameByKey: Map<string, string | null>;
  if (precomputedOverallContext) {
    scores = precomputedOverallContext.overallScores;
    carNameByKey = new Map(
      [...precomputedOverallContext.rawByKey.values()].map((r) => [
        resultKey(r.subsession_id, r.race_number, r.cust_id),
        r.car_name,
      ]),
    );
  } else {
    const scoresRaw = await getRaceScoresForSeasonOverall(env, season.id);
    scores =
      exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
    const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
    const rawResults = await getCuratedRaceResultsForSubsessions(env, subsessionIds);
    carNameByKey = new Map(
      rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r.car_name]),
    );
  }
  if (scores.length === 0) return new Map();
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));

  // --- Cars: tally per-driver usage, one count per race started in that car. ---
  const carCountsByDriver = new Map<string, Map<string, number>>();
  for (const s of scores) {
    const custId = custIdByDriverId.get(s.driver_id);
    const carName =
      custId != null ? carNameByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    if (!carName) continue;
    if (!carCountsByDriver.has(s.driver_id)) carCountsByDriver.set(s.driver_id, new Map());
    const m = carCountsByDriver.get(s.driver_id)!;
    m.set(carName, (m.get(carName) ?? 0) + 1);
  }

  // --- Teams: tally races raced under each team, and figure out who was
  // one of the top 2 scorers for their team in each individual race. ---
  const racesUnderByDriverTeam = new Map<string, Map<string, number>>(); // driverId -> teamId -> count
  const teamRaceGroups = new Map<string, RaceScoreOverallRow[]>(); // "subsession:race:team" -> that team's rows for that race
  for (const s of scores) {
    if (!s.team_id) continue;
    if (!racesUnderByDriverTeam.has(s.driver_id)) racesUnderByDriverTeam.set(s.driver_id, new Map());
    const m = racesUnderByDriverTeam.get(s.driver_id)!;
    m.set(s.team_id, (m.get(s.team_id) ?? 0) + 1);

    const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
    if (!teamRaceGroups.has(key)) teamRaceGroups.set(key, []);
    teamRaceGroups.get(key)!.push(s);
  }

  const scoredForTeamByDriverTeam = new Map<string, Map<string, number>>(); // driverId -> teamId -> count
  const overallPointsOf = (s: RaceScoreOverallRow) =>
    s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
  for (const group of teamRaceGroups.values()) {
    for (const s of topTeamScorers(group, overallPointsOf)) {
      if (!scoredForTeamByDriverTeam.has(s.driver_id)) scoredForTeamByDriverTeam.set(s.driver_id, new Map());
      const m = scoredForTeamByDriverTeam.get(s.driver_id)!;
      m.set(s.team_id as string, (m.get(s.team_id as string) ?? 0) + 1);
    }
  }

  const out = new Map<string, DriverSeasonExtras>();
  const driverIds = new Set([...carCountsByDriver.keys(), ...racesUnderByDriverTeam.keys()]);
  for (const driverId of driverIds) {
    const cars: DriverCarStat[] = [...(carCountsByDriver.get(driverId)?.entries() ?? [])]
      .map(([carName, races]) => ({ carName, logoUrl: carLogoByName.get(carName) ?? null, races }))
      .sort((a, b) => b.races - a.races);

    const teamsForDriver = racesUnderByDriverTeam.get(driverId);
    const teamsOut: DriverTeamStat[] = teamsForDriver
      ? [...teamsForDriver.entries()]
          .map(([teamId, racesUnderTeam]) => {
            const team = teamById.get(teamId);
            return {
              teamId,
              teamName: team?.name ?? 'Unknown Team',
              logoUrl: team ? resolveTeamLogo(team, season.id, seasonLogoMap) : null,
              racesUnderTeam,
              racesScoredForTeam: scoredForTeamByDriverTeam.get(driverId)?.get(teamId) ?? 0,
            };
          })
          .sort((a, b) => b.racesUnderTeam - a.racesUnderTeam)
      : [];

    out.set(driverId, { cars, teams: teamsOut });
  }
  return out;
}
