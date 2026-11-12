/**
 * Race summaries for Stats > Seasons (BR5.6): the rounds go to season_race_summaries in batches the function
 * and PostgREST accept, an empty list makes no call, and a failed batch fails the whole load.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/db/client', () => ({ restRpc: vi.fn() }));

import { restRpc } from '../../src/lib/db/client';
import {
  SEASON_SUMMARIES_BATCH,
  SEASON_SUMMARIES_MAX_ROUNDS,
  getSeasonRaceSummaries,
  type RaceSummaryRow,
} from '../../src/lib/results/seasonRaceSummaries';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const rpc = vi.mocked(restRpc);

function summary(round: number | string, race = 1): RaceSummaryRow {
  return {
    subsession_id: round as number,
    race_number: race,
    scope: 'overall',
    winner_driver_id: 'driver-a',
    drivers: 20,
    round_drivers: 21,
    laps_total: 400,
    incidents_total: 30,
    race_time_ten_thousandths: 36_000_000,
  };
}

beforeEach(() => {
  rpc.mockReset();
});

describe('getSeasonRaceSummaries', () => {
  it('makes no call for an empty list', async () => {
    expect(await getSeasonRaceSummaries(env, [])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks once for a small list and returns the rows', async () => {
    rpc.mockResolvedValueOnce([summary(9001), summary(9001, 2)]);
    const rows = await getSeasonRaceSummaries(env, [9001, 9002]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(env, 'season_race_summaries', { p_subsession_ids: [9001, 9002] });
    expect(rows.map((r) => r.race_number)).toEqual([1, 2]);
  });

  it('splits a long list into batches within the function limit and the response row cap', async () => {
    rpc.mockResolvedValue([]);
    const ids = Array.from({ length: 2 * SEASON_SUMMARIES_BATCH + 10 }, (_, i) => 1000 + i);
    await getSeasonRaceSummaries(env, ids);
    const sizes = rpc.mock.calls.map(
      (call) => (call[2] as { p_subsession_ids: number[] }).p_subsession_ids.length,
    );
    expect(sizes).toEqual([SEASON_SUMMARIES_BATCH, SEASON_SUMMARIES_BATCH, 10]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(SEASON_SUMMARIES_MAX_ROUNDS);
    // 3 races x 4 scopes per round stays under PostgREST's 1000-row cap.
    expect(SEASON_SUMMARIES_BATCH * 12).toBeLessThanOrEqual(1000);
    // Every round is asked for exactly once.
    const asked = rpc.mock.calls.flatMap(
      (call) => (call[2] as { p_subsession_ids: number[] }).p_subsession_ids,
    );
    expect(asked.sort((a, b) => a - b)).toEqual(ids);
  });

  it('drops duplicate and unsafe ids before asking', async () => {
    rpc.mockResolvedValueOnce([]);
    await getSeasonRaceSummaries(env, [5, 5, Number.NaN, 6]);
    expect(rpc).toHaveBeenCalledWith(env, 'season_race_summaries', { p_subsession_ids: [5, 6] });
  });

  it('reads bigint subsession ids that arrive as strings as numbers', async () => {
    rpc.mockResolvedValueOnce([summary('9001')]);
    const [row] = await getSeasonRaceSummaries(env, [9001]);
    expect(row.subsession_id).toBe(9001);
  });

  it('fails the whole load when one batch fails', async () => {
    rpc.mockResolvedValueOnce([summary(1)]).mockRejectedValueOnce(new Error('Supabase RPC error 500'));
    const ids = Array.from({ length: SEASON_SUMMARIES_BATCH + 1 }, (_, i) => i + 1);
    await expect(getSeasonRaceSummaries(env, ids)).rejects.toThrow('Supabase RPC error 500');
  });
});
