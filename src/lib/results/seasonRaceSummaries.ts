/**
 * Per-race figures for Stats > Seasons (BR5.6): one row per race and scope from the database function
 * season_race_summaries, which applies the raw/final rule and the winner rule under the caller's permissions.
 */
import { restRpc, type SupabaseEnv } from '../db/client';

export type SummaryScope = 'overall' | 'alpha' | 'gamma' | 'delta';

/** One row as season_race_summaries returns it. */
export interface RaceSummaryRow {
  subsession_id: number;
  race_number: number;
  scope: SummaryScope;
  winner_driver_id: string | null;
  drivers: number;
  round_drivers: number;
  laps_total: number | null;
  incidents_total: number | null;
  race_time_ten_thousandths: number | null;
}

/** The database function refuses more than this many rounds per call. */
export const SEASON_SUMMARIES_MAX_ROUNDS = 200;

/**
 * Rounds asked for per call. Below the function's limit because PostgREST caps a response at 1000 rows: a
 * round gives up to 3 races x 4 scopes = 12 rows, so 80 rounds stay under the cap.
 */
export const SEASON_SUMMARIES_BATCH = 80;

/**
 * Race summaries of these rounds, in batches run in parallel. The caller passes only rounds the reader may
 * see (broadcaster-hidden rounds already left out, since restRpc adds no filter). Throws on any failed batch,
 * so the page shows its load error instead of a season with rounds missing.
 */
export async function getSeasonRaceSummaries(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<RaceSummaryRow[]> {
  const ids = [...new Set(subsessionIds.filter((id) => Number.isSafeInteger(id)))];
  if (ids.length === 0) return [];
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += SEASON_SUMMARIES_BATCH)
    batches.push(ids.slice(i, i + SEASON_SUMMARIES_BATCH));
  const results = await Promise.all(
    batches.map((batch) =>
      restRpc<RaceSummaryRow[]>(env, 'season_race_summaries', { p_subsession_ids: batch }),
    ),
  );
  return results.flatMap((rows) =>
    (rows ?? []).map((row) => ({ ...row, subsession_id: Number(row.subsession_id) })),
  );
}
