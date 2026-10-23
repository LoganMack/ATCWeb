/**
 * Reads of the stored per-round stats (round_driver_stats, round_team_stats, round_penalty_points), which the
 * database refreshes (migration 20261026120000). Every read goes through restGet/restGetAll, so broadcaster
 * mode hides its round here too (BR2.4). round_stats_status says per season whether the stored rows are
 * current; a season that is not falls back to the live path.
 */
import { restGetAll, restRpc, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

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

/** The seasons one driver has stored rows in (season ids only). */
export async function getDriverStoredSeasonIds(env: SupabaseEnv, driverId: string): Promise<Set<string>> {
  const rows = await restGetAll<{ season_id: string }>(
    env,
    `round_driver_stats?select=season_id&driver_id=eq.${encodeURIComponent(driverId)}&order=subsession_id.asc`,
  );
  return new Set(rows.map((r) => r.season_id));
}

/** Whether one season's stored rows are current; `reason` is the database's first reason when not. */
export interface SeasonStatsStatus {
  current: boolean;
  reason: string | null;
}

/**
 * round_stats_status for these seasons in one call, memoised per request. A season the database leaves
 * out of its answer counts as not current. The function is per season, so in broadcaster mode the hidden
 * round's freshness doesn't matter: its rows are filtered out of every read anyway.
 */
export function getRoundStatsStatus(
  env: SupabaseEnv,
  seasonIds: string[],
): Promise<Map<string, SeasonStatsStatus>> {
  const ids = [...new Set(seasonIds)].sort();
  if (ids.length === 0) return Promise.resolve(new Map());
  return memoized(env, 'getRoundStatsStatus', [ids], async () => {
    const rows = await restRpc<{ season_id: string; current: boolean; reason: string | null }[]>(
      env,
      'round_stats_status',
      { p_season_ids: ids },
    );
    const bySeason = new Map(
      rows.map((r) => [r.season_id, { current: r.current === true, reason: r.reason }]),
    );
    return new Map(
      ids.map((id) => [id, bySeason.get(id) ?? { current: false, reason: 'no status returned' }] as const),
    );
  });
}
