import { restDelete, restGet, restPost, type SupabaseEnv } from './client';

// --- Manual awards (Best Racecraft / Most Improved — steward picks, not
// computed from race data the way the other ten Awards-page entries are;
// see computeSeasonAwardsHistory in results.ts, and 0069_manual_awards.sql) -

export type ManualAwardKey = 'best_racecraft' | 'most_improved';

export interface ManualAward {
  id: string;
  season_id: string;
  award_key: ManualAwardKey;
  driver_id: string;
}

const MANUAL_AWARD_SELECT = 'id,season_id,award_key,driver_id';

/** Every manual award winner on file, every season — a small table, fetched whole and grouped client-side (see awards/fragment.astro), same "one fetch, filter in memory" shape getSeasons/getScoringRulesets already use for similarly small reference tables. */
export function getManualAwards(env: SupabaseEnv) {
  return restGet<ManualAward[]>(env, `manual_awards?select=${MANUAL_AWARD_SELECT}`);
}

/** One season's manual award winners (both keys at once) — powers the admin editor. */
export function getManualAwardsForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<ManualAward[]>(
    env,
    `manual_awards?select=${MANUAL_AWARD_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

/** Adds one driver as a winner of one award for one season. Insert only, no update — same "changing a pick is remove-then-add" shape as team_rosters. Throws (with the unique constraint's own error) if this exact (season, award, driver) triple is already on file. */
export function addManualAward(
  env: SupabaseEnv,
  accessToken: string,
  data: { season_id: string; award_key: ManualAwardKey; driver_id: string },
) {
  return restPost<ManualAward>(env, accessToken, 'manual_awards', data);
}

export function removeManualAward(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `manual_awards?id=eq.${encodeURIComponent(id)}`);
}
