import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import type { EventRecord } from '../db/events';
import { isChampionshipSeason } from './shared';
import type { RoundSummary } from './rows';

// ---------------------------------------------------------------------------
// Race results — browsing rounds and their race-by-race results
// ---------------------------------------------------------------------------

const ROUND_SUMMARY_SELECT =
  'subsession_id,season_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers';

/** Every round for a season, most recent first. */
export function getRoundsForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&order=start_time.desc`,
  );
}

/** Every round across every season, most recent first — powers the "link to a round" picker on the news post editor (src/pages/admin/news/*), which needs to search/pick across all of history rather than one season at a time. One query rather than N getRoundsForSeason() calls, since a per-season loop would be exactly the kind of N+1 this file's header already warns against on pages that list many seasons at once. */
export function getAllRounds(env: SupabaseEnv) {
  // restGetAll: there are enough rounds that a plain restGet could silently stop at Supabase's 1000-row cap.
  return restGetAll<RoundSummary>(env, `curated_rounds?select=${ROUND_SUMMARY_SELECT}&order=start_time.desc`);
}

/**
 * Start times of officially scored rounds, for the "X/12 rounds absent" inactivity tooltip, counted the way
 * sync_driver_statuses() does (0063). Probation (isOnProbationNow in src/lib/penalties/penaltyPoints.ts)
 * counts calendar events instead; inactivity must match the database rule or the tooltip runs ahead of it.
 */
export function getOfficialRoundStartTimes(env: SupabaseEnv) {
  return restGetAll<{ start_time: string }>(
    env,
    `curated_rounds?select=start_time&status=eq.official&order=start_time.asc`,
  );
}

export async function getRoundBySubsessionId(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<RoundSummary | null> {
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&subsession_id=eq.${subsessionId}`,
  );
  return rounds[0] ?? null;
}

/** Just the newest round on file (by start_time) — powers the homepage's "Previous Result" card. A dedicated `limit=1` query rather than getAllRounds()[0]; no reason to pull the whole table's history down to the edge function just to look at the first row. */
export async function getMostRecentRound(env: SupabaseEnv): Promise<RoundSummary | null> {
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&order=start_time.desc&limit=1`,
  );
  return rounds[0] ?? null;
}

/**
 * Resolves an admin-scheduled event to its curated_rounds row, live (0035_events_rounds_categories.sql).
 * First by season_id + the pipeline's own round_number (not the display "Round N"; manual imports leave it
 * null), then by the admin-pinned subsession_id.
 */
export async function getEventRound(env: SupabaseEnv, event: EventRecord): Promise<RoundSummary | null> {
  if (event.season_id && event.round_number != null) {
    const rounds = await getRoundsForSeason(env, event.season_id);
    const match = rounds.find((r) => r.round_number === event.round_number);
    if (match) return match;
  }
  if (event.subsession_id != null) {
    return getRoundBySubsessionId(env, event.subsession_id);
  }
  return null;
}

/**
 * Each round's displayed "Round N", chronological within the season, skipping exhibition and test rounds
 * (flagged per round, or a non-championship season) so no gap is left (Logan). Null for an excluded round,
 * which the UI labels "Exhibition" or "Test".
 */
export function computeDisplayRoundNumbers(
  rounds: RoundSummary[],
  exhibitionRoundIds: Set<number>,
  testRoundIds: Set<number>,
): Map<number, number | null> {
  const chronological = [...rounds].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
  );
  const out = new Map<number, number | null>();
  let counter = 0;
  for (const r of chronological) {
    const excluded =
      exhibitionRoundIds.has(r.subsession_id) ||
      testRoundIds.has(r.subsession_id) ||
      (r.season_label ? !isChampionshipSeason(r.season_label) : false);
    out.set(r.subsession_id, excluded ? null : ++counter);
  }
  return out;
}
