/**
 * The stored-stats loaders (BR2.4, BR4.1) and the trimmed round picker (BR3.1 as decided): broadcaster
 * mode filters the hidden round out of every stored read, round_stats_status decides per season between
 * the stored rows and the live path (one call, memoised), a failed call or read sends every season live,
 * a driver profile is never empty before the backfill, and the picker reads only its own columns.
 * The shared fetch helper is stubbed; no network is used.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseEnv } from '../../src/lib/db/client';
import { getRoundStatsForSeasons, getRoundStatsStatus } from '../../src/lib/db/roundStats';
import { getPenaltiesForDriver } from '../../src/lib/db/penalties';
import { PICKER_ROUND_SELECT, getRoundPickerRounds } from '../../src/lib/results/rounds';
import { driverCareerSeasons, loadStoredSeasons } from '../../src/lib/results/roundStatsAdapter';
import { RequestMemo } from '../../src/lib/requestMemo';
import type { Season } from '../../src/lib/db/seasons';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type StatusRow = { season_id: string; current: boolean; reason: string | null };

/**
 * Stubs fetch: `answer` gives a GET's JSON body by URL, `rpc` the round_stats_status rows for the season
 * ids it is called with (or throws, for a failed call).
 */
function stubFetch(answer: (url: string) => unknown, rpc: (ids: string[]) => StatusRow[] = () => []) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: decodeURIComponent(String(url)), method, body });
    if (String(url).includes('/rest/v1/rpc/round_stats_status')) {
      try {
        return new Response(JSON.stringify(rpc(body.p_season_ids)), { status: 200 });
      } catch {
        return new Response('{"message":"boom"}', { status: 500 });
      }
    }
    return new Response(JSON.stringify(answer(String(url))), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const env = (hiddenSubsessionIds?: number[], memo?: RequestMemo): SupabaseEnv => ({
  url: 'https://example.invalid',
  anonKey: 'anon',
  hiddenSubsessionIds,
  memo,
});

const season = (id: string, name: string): Season => ({ id, name, number: Number(name.slice(3)) }) as Season;

/** Captures console.warn and console.error lines while `run` runs. */
async function logs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const { warn, error } = console;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    return { result: await run(), lines };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

describe('stored round stats loaders', () => {
  it('filters the hidden round out of every stored read, and reads only the parts a page shows', async () => {
    const calls = stubFetch(() => []);
    await getRoundStatsForSeasons(env([71031341]), ['s1']);
    const tables = calls.map((c) => c.url.split('/rest/v1/')[1].split('?')[0]).sort();
    expect(tables).toEqual(['round_driver_stats', 'round_penalty_points', 'round_team_stats']);
    for (const c of calls) expect(c.url).toContain('subsession_id=not.in.(71031341)');

    // Nothing hidden: no filter, and an empty season list costs no request at all.
    const plain = stubFetch(() => []);
    await getRoundStatsForSeasons(env(), ['s1']);
    for (const c of plain) expect(c.url).not.toContain('not.in');
    await getRoundStatsForSeasons(env(), []);
    expect(plain).toHaveLength(3);

    const trimmed = stubFetch(() => []);
    await getRoundStatsForSeasons(env(), ['s1'], {
      teamCompetitions: ['overall', '3'],
      penaltyPoints: false,
    });
    expect(trimmed.map((c) => c.url.split('/rest/v1/')[1].split('?')[0]).sort()).toEqual([
      'round_driver_stats',
      'round_team_stats',
    ]);
    expect(trimmed.find((c) => c.url.includes('round_team_stats'))!.url).toContain(
      'competition=in.(overall,3)',
    );
    const driversOnly = stubFetch(() => []);
    await getRoundStatsForSeasons(env(), ['s1'], { teamCompetitions: [], penaltyPoints: false });
    expect(driversOnly).toHaveLength(1);
  });

  it('asks round_stats_status once for every season: current is stored, not current is live with its reason', async () => {
    const seasons = [season('s16', 'ATC16'), season('s17', 'ATC17'), season('s18', 'ATC18')];
    const calls = stubFetch(
      () => [],
      (ids) =>
        ids.map((id) =>
          id === 's17'
            ? { season_id: id, current: false, reason: 'Stored stats are older than the scores' }
            : id === 's18'
              ? { season_id: id, current: false, reason: 'No such season' }
              : { season_id: id, current: true, reason: null },
        ),
    );
    const { result: load, lines } = await logs(() => loadStoredSeasons(env(), seasons, new Set()));
    expect([...load.stats.keys()]).toEqual(['s16']);
    expect(load.live.map((s) => s.id)).toEqual(['s17', 's18']);
    expect(lines).toEqual([
      'round stats incomplete: season ATC17 (Stored stats are older than the scores)',
      'round stats incomplete: season ATC18 (No such season)',
    ]);
    const rpcCalls = calls.filter((c) => c.url.includes('/rpc/'));
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].method).toBe('POST');
    expect(rpcCalls[0].body).toEqual({ p_season_ids: ['s16', 's17', 's18'] });

    // A season the answer leaves out is not current; one request's repeated ask is memoised.
    const memoEnv = env(undefined, new RequestMemo());
    const memoCalls = stubFetch(
      () => [],
      () => [{ season_id: 's16', current: true, reason: null }],
    );
    const status = await getRoundStatsStatus(memoEnv, ['s17', 's16', 's16']);
    expect(status.get('s16')).toEqual({ current: true, reason: null });
    expect(status.get('s17')?.current).toBe(false);
    await getRoundStatsStatus(memoEnv, ['s16', 's17']);
    expect(memoCalls.filter((c) => c.url.includes('/rpc/'))).toHaveLength(1);
  });

  it('sends every season live when the status call fails or the stored tables cannot be read', async () => {
    const seasons = [season('s16', 'ATC16'), season('s17', 'ATC17')];
    stubFetch(
      () => [],
      () => {
        throw new Error('rpc down');
      },
    );
    const failedCall = await logs(() => loadStoredSeasons(env(), seasons, new Set()));
    expect(failedCall.result.stats.size).toBe(0);
    expect(failedCall.result.live).toEqual(seasons);
    expect(failedCall.lines.join('\n')).toContain('Supabase RPC error 500 on round_stats_status');

    // Tables missing (before the migration): every read is a 404.
    globalThis.fetch = (async () =>
      new Response('{"code":"PGRST205"}', { status: 404 })) as unknown as typeof fetch;
    const missing = await logs(() => loadStoredSeasons(env(), seasons, new Set()));
    expect(missing.result.live).toEqual(seasons);
  });

  it('gives a driver profile their stored seasons plus every season that is not current, never none', async () => {
    const seasons = [season('s16', 'ATC16'), season('s17', 'ATC17'), season('s18', 'ATC18')];
    const allCurrent = (ids: string[]) => ids.map((id) => ({ season_id: id, current: true, reason: null }));

    // Backfilled and current: only the seasons the driver has rows in.
    stubFetch(() => [{ season_id: 's17' }, { season_id: 's17' }], allCurrent);
    const backfilled = await driverCareerSeasons(env(), 'd1', seasons);
    expect(backfilled.seasons.map((s) => s.id)).toEqual(['s17']);
    expect(backfilled.status?.get('s16')?.current).toBe(true);

    // ATC18 is stale: it is computed live, whether or not the driver has rows there.
    stubFetch(
      () => [{ season_id: 's17' }],
      (ids) =>
        ids.map((id) => ({
          season_id: id,
          current: id !== 's18',
          reason: id === 's18' ? 'A round of this season has a recorded refresh issue' : null,
        })),
    );
    expect((await driverCareerSeasons(env(), 'd1', seasons)).seasons.map((s) => s.id)).toEqual([
      's17',
      's18',
    ]);

    // Before the backfill: no stored rows and nothing current, so every season.
    stubFetch(
      () => [],
      (ids) =>
        ids.map((id) => ({ season_id: id, current: false, reason: 'A scored round has no stored stats' })),
    );
    expect((await driverCareerSeasons(env(), 'd1', seasons)).seasons).toEqual(seasons);

    // A failed read: every season, and no status to reuse.
    globalThis.fetch = (async () =>
      new Response('{"code":"PGRST205"}', { status: 404 })) as unknown as typeof fetch;
    const failed = await logs(() => driverCareerSeasons(env(), 'd1', seasons));
    expect(failed.result).toEqual({ seasons, status: null });
  });

  it('reads the round picker with only the columns it shows', async () => {
    const calls = stubFetch(() => []);
    await getRoundPickerRounds(env());
    expect(calls).toHaveLength(1);
    const select = /select=([^&]*)/.exec(calls[0].url)![1];
    expect(select).toBe(PICKER_ROUND_SELECT);
    expect(select.split(',').sort()).toEqual(
      ['round_number', 'season_id', 'season_label', 'start_time', 'subsession_id', 'track_name'].sort(),
    );
    expect(calls[0].url).toContain('curated_rounds?');
  });

  it("filters a driver's penalties in the database and keeps a doubly matched one once", async () => {
    const row = (id: string, created_at: string) => ({
      id,
      created_at,
      subsession_id: 1,
      penalty_offense_links: [],
      penalty_involved_drivers: [{ driver_id: 'd1' }],
    });
    const calls = stubFetch((url) =>
      !decodeURIComponent(url).includes('involved_match.driver_id')
        ? [row('p2', '2026-01-02T00:00:00+00:00')]
        : [
            { ...row('p1', '2026-01-01T00:00:00+00:00'), involved_match: [{ driver_id: 'd1' }] },
            { ...row('p2', '2026-01-02T00:00:00+00:00'), involved_match: [{ driver_id: 'd1' }] },
          ],
    );
    const penalties = await getPenaltiesForDriver(env(), 'd1');
    expect(penalties.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(penalties[0]).not.toHaveProperty('involved_match');
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('involved_match.driver_id=eq.d1'))).toBe(true);
    // Neither read lists every penalty in the league.
    for (const c of calls) expect(c.url).toMatch(/driver_id=eq\.d1/);
  });
});
