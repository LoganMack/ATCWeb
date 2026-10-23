/**
 * Reads of the stored per-round stats (round_driver_stats, round_team_stats, round_penalty_points), which the
 * database refreshes (migration 20261026120000). Every read goes through restGet/restGetAll, so broadcaster
 * mode hides its round here too (BR2.4). The completeness check decides when a season must fall back to the
 * live path: the stored starts must add up to the season's score rows.
 */
import { restCount, restGetAll, type SupabaseEnv } from './client';

/** One driver's numbers for one round, as a signed-out visitor sees them. */
export interface RoundDriverStatsRow {
  subsession_id: number;
  driver_id: string;
  season_id: string;
  class_id: number;
  team_id: string | null;
  final_visible: boolean;
  overall_points: number;
  class_points: number;
  starts: number;
  class_wins: number;
  class_podiums: number;
  class_top5s: number;
  class_top10s: number;
  overall_wins: number;
  overall_podiums: number;
  overall_top5s: number;
  overall_top10s: number;
  overall_pole: boolean;
  class_pole: boolean;
  laps: number;
  laps_led: number;
  net_positions: number;
  incidents: number;
  bonus_points: number;
  /** car_name -> races driven in it this round. */
  cars: Record<string, number>;
  races_under_team: number;
  races_scored_for_team: number;
}

/** One team's top-2-per-race points and starts in one round, for one competition: 'overall' or a class id. */
export interface RoundTeamStatsRow {
  subsession_id: number;
  team_id: string;
  competition: string;
  season_id: string;
  points: number;
  starts: number;
}

/** One driver's effective penalty points in one posted round, score row or not. */
export interface RoundPenaltyPointsRow {
  subsession_id: number;
  driver_id: string;
  season_id: string;
  penalty_points: number;
}

export const ROUND_DRIVER_STATS_SELECT =
  'subsession_id,driver_id,season_id,class_id,team_id,final_visible,overall_points,class_points,starts,' +
  'class_wins,class_podiums,class_top5s,class_top10s,overall_wins,overall_podiums,overall_top5s,overall_top10s,' +
  'overall_pole,class_pole,laps,laps_led,net_positions,incidents,bonus_points,cars,races_under_team,' +
  'races_scored_for_team';
export const ROUND_TEAM_STATS_SELECT = 'subsession_id,team_id,competition,season_id,points,starts';
export const ROUND_PENALTY_POINTS_SELECT = 'subsession_id,driver_id,season_id,penalty_points';

export interface StoredRoundStats {
  driverRows: RoundDriverStatsRow[];
  teamRows: RoundTeamStatsRow[];
  penaltyRows: RoundPenaltyPointsRow[];
}

function seasonFilter(seasonIds: string[]): string {
  return `season_id=in.(${seasonIds.map((id) => encodeURIComponent(id)).join(',')})`;
}

/**
 * Which of the optional tables a page reads, to keep its subrequests down: the team competitions it shows
 * ('overall' or class ids; an empty list reads no team rows) and whether it shows penalty points.
 */
export interface RoundStatsParts {
  teamCompetitions?: string[];
  penaltyPoints?: boolean;
}

/** Every stored row of these seasons, the tables in parallel, paged in a stable order. */
export async function getRoundStatsForSeasons(
  env: SupabaseEnv,
  seasonIds: string[],
  parts: RoundStatsParts = {},
): Promise<StoredRoundStats> {
  if (seasonIds.length === 0) return { driverRows: [], teamRows: [], penaltyRows: [] };
  const filter = seasonFilter(seasonIds);
  const competitions = parts.teamCompetitions;
  const competitionFilter = competitions
    ? `&competition=in.(${competitions.map(encodeURIComponent).join(',')})`
    : '';
  const [driverRows, teamRows, penaltyRows] = await Promise.all([
    restGetAll<RoundDriverStatsRow>(
      env,
      `round_driver_stats?select=${ROUND_DRIVER_STATS_SELECT}&${filter}&order=subsession_id.asc,driver_id.asc`,
    ),
    competitions && competitions.length === 0
      ? Promise.resolve([] as RoundTeamStatsRow[])
      : restGetAll<RoundTeamStatsRow>(
          env,
          `round_team_stats?select=${ROUND_TEAM_STATS_SELECT}&${filter}${competitionFilter}&order=subsession_id.asc,team_id.asc,competition.asc`,
        ),
    parts.penaltyPoints === false
      ? Promise.resolve([] as RoundPenaltyPointsRow[])
      : restGetAll<RoundPenaltyPointsRow>(
          env,
          `round_penalty_points?select=${ROUND_PENALTY_POINTS_SELECT}&${filter}&order=subsession_id.asc,driver_id.asc`,
        ),
  ]);
  return { driverRows, teamRows, penaltyRows };
}

/** One driver's stored rounds: only the season and the starts, to find their seasons and check them. */
export interface DriverStoredRound {
  season_id: string;
  starts: number;
}

export function getDriverStoredRounds(env: SupabaseEnv, driverId: string) {
  return restGetAll<DriverStoredRound>(
    env,
    `round_driver_stats?select=season_id,starts&driver_id=eq.${encodeURIComponent(driverId)}&order=subsession_id.asc`,
  );
}

/** How many race_score_results_public rows these seasons have (a HEAD count, no rows transferred). */
export function countSeasonScoreRows(env: SupabaseEnv, seasonIds: string[]): Promise<number> {
  if (seasonIds.length === 0) return Promise.resolve(0);
  return restCount(env, `race_score_results_public?select=subsession_id&${seasonFilter(seasonIds)}`);
}

/** How many race_score_results_public rows one driver has, every season. */
export function countDriverScoreRows(env: SupabaseEnv, driverId: string): Promise<number> {
  return restCount(
    env,
    `race_score_results_public?select=subsession_id&driver_id=eq.${encodeURIComponent(driverId)}`,
  );
}

/** Season id -> the sum of `starts` over its stored driver rows: one score row per start. */
export function storedStartsBySeason(
  rows: Pick<RoundDriverStatsRow, 'season_id' | 'starts'>[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.season_id, (out.get(r.season_id) ?? 0) + r.starts);
  return out;
}

/**
 * The seasons whose stored rows don't account for every score row: before the backfill, after a round's
 * refresh failed and removed it, or with the kill switch off while scores changed. One HEAD count covers
 * every season; only a mismatch costs one more count per season, to say which. Each one is logged.
 */
export async function findIncompleteSeasons(
  env: SupabaseEnv,
  seasons: { id: string; name: string }[],
  storedStarts: Map<string, number>,
  /** The total count, when the caller already started it alongside the row reads. */
  totalCount?: Promise<number>,
): Promise<Set<string>> {
  if (seasons.length === 0) return new Set();
  const ids = seasons.map((s) => s.id);
  const storedTotal = ids.reduce((sum, id) => sum + (storedStarts.get(id) ?? 0), 0);
  const total = await (totalCount ?? countSeasonScoreRows(env, ids));
  if (total === storedTotal) return new Set();
  const counts = await Promise.all(seasons.map((s) => countSeasonScoreRows(env, [s.id])));
  const incomplete = new Set<string>();
  seasons.forEach((s, i) => {
    if (counts[i] !== (storedStarts.get(s.id) ?? 0)) {
      incomplete.add(s.id);
      console.warn(
        `round stats incomplete: season ${s.name} (${storedStarts.get(s.id) ?? 0} of ${counts[i]} starts stored)`,
      );
    }
  });
  return incomplete;
}
