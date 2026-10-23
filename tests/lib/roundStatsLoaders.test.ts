/**
 * The stored-stats loaders (BR2.4, BR4.1) and the trimmed round picker (BR3.1 as decided): broadcaster
 * mode filters the hidden round out of every stored read and count, the completeness check finds the
 * season whose stored starts fall short of its score rows, and the picker reads only its own columns.
 * The shared fetch helper is stubbed; no network is used.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseEnv } from '../../src/lib/db/client';
import {
  countSeasonScoreRows,
  findIncompleteSeasons,
  getRoundStatsForSeasons,
  storedStartsBySeason,
} from '../../src/lib/db/roundStats';
import { getPenaltiesForDriver } from '../../src/lib/db/penalties';
import { PICKER_ROUND_SELECT, getRoundPickerRounds } from '../../src/lib/results/rounds';
import { loadDriverStoredSeasonIds, loadStoredSeasons } from '../../src/lib/results/roundStatsAdapter';
import type { Season } from '../../src/lib/db/seasons';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

interface Call {
  url: string;
  method: string;
}

/**
 * Stubs fetch: `answer` returns the JSON body for a GET (or throws), and `counts` the Content-Range total
 * for a HEAD, both by URL.
 */
function stubFetch(answer: (url: string) => unknown, counts: (url: string) => number = () => 0) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: decodeURIComponent(String(url)), method });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Range': `0-0/${counts(String(url))}` } });
    }
    return new Response(JSON.stringify(answer(String(url))), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const env = (hiddenSubsessionIds?: number[]): SupabaseEnv => ({
  url: 'https://example.invalid',
  anonKey: 'anon',
  hiddenSubsessionIds,
});

const season = (id: string, name: string): Season => ({ id, name, number: Number(name.slice(3)) }) as Season;

describe('stored round stats loaders', () => {
  it('filters the hidden round out of every stored read and the score count', async () => {
    const calls = stubFetch(() => []);
    await getRoundStatsForSeasons(env([71031341]), ['s1']);
    await countSeasonScoreRows(env([71031341]), ['s1']);
    const tables = calls.map((c) => c.url.split('/rest/v1/')[1].split('?')[0]).sort();
    expect(tables).toEqual([
      'race_score_results_public',
      'round_driver_stats',
      'round_penalty_points',
      'round_team_stats',
    ]);
    for (const c of calls) expect(c.url).toContain('subsession_id=not.in.(71031341)');
    expect(calls.find((c) => c.url.includes('race_score_results_public'))!.method).toBe('HEAD');

    // Nothing hidden: no filter, and an empty season list costs no request at all.
    const plain = stubFetch(() => []);
    await getRoundStatsForSeasons(env(), ['s1']);
    for (const c of plain) expect(c.url).not.toContain('not.in');
    await getRoundStatsForSeasons(env(), []);
    expect(plain).toHaveLength(3);

    // A page reads only the team competitions and penalty points it shows.
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

  it('finds the season whose stored rows miss a round, and only then counts per season', async () => {
    const seasons = [season('s16', 'ATC16'), season('s17', 'ATC17')];
    const stored = storedStartsBySeason([
      { season_id: 's16', starts: 120 },
      { season_id: 's17', starts: 100 },
      { season_id: 's17', starts: 20 },
    ]);
    // ATC17 has 160 score rows but only 120 stored starts: one round is missing.
    const score: Record<string, number> = { s16: 120, s17: 160 };
    const count = (url: string) => {
      const ids = /season_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(url))![1].split(',');
      return ids.reduce((sum, id) => sum + score[id], 0);
    };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (msg: string) => warned.push(msg);
    try {
      const calls = stubFetch(() => [], count);
      expect([...(await findIncompleteSeasons(env(), seasons, stored))]).toEqual(['s17']);
      expect(calls.filter((c) => c.method === 'HEAD')).toHaveLength(3);
      expect(warned).toEqual(['round stats incomplete: season ATC17 (120 of 160 starts stored)']);

      // Complete: the one total count is all it costs.
      score.s17 = 120;
      const ok = stubFetch(() => [], count);
      expect([...(await findIncompleteSeasons(env(), seasons, stored))]).toEqual([]);
      expect(ok).toHaveLength(1);
    } finally {
      console.warn = warn;
    }
  });

  it('sends every season to the live path when the stored tables cannot be read', async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      globalThis.fetch = (async () =>
        new Response('{"code":"PGRST205"}', { status: 404 })) as unknown as typeof fetch;
      const seasons = [season('s17', 'ATC17')];
      const load = await loadStoredSeasons(env(), seasons, new Set());
      expect(load.stats.size).toBe(0);
      expect(load.live).toEqual(seasons);
      // A driver whose stored starts can't be read or don't match is not trusted.
      expect(await loadDriverStoredSeasonIds(env(), 'd1')).toBeNull();
      stubFetch(
        () => [{ season_id: 's17', starts: 3 }],
        () => 4,
      );
      expect(await loadDriverStoredSeasonIds(env(), 'd1')).toBeNull();
      stubFetch(
        () => [{ season_id: 's17', starts: 4 }],
        () => 4,
      );
      expect(await loadDriverStoredSeasonIds(env(), 'd1')).toEqual(new Set(['s17']));
    } finally {
      console.error = error;
    }
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
