/**
 * Orphaned rounds on Admin > Events: the reasons the database gives for not auto-linking a round
 * (public.round_event_matches, 20261112120000_round_auto_link.sql), how they reach the page, and the
 * page's own pre-selection (suggestEvent). The matching itself is checked against a real database by
 * supabase/checks/round-auto-link-fixtures.sql. The shared fetch helper is stubbed; no network is used.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseEnv } from '../../src/lib/db/client';
import type { EventWithCircuit } from '../../src/lib/db/events';
import {
  describeLinkReason,
  getOrphanedRounds,
  getRoundLinkReasons,
  suggestEvent,
  type OrphanRound,
  type RoundLinkReason,
} from '../../src/lib/orphanRounds';

const env: SupabaseEnv = { url: 'https://example.invalid', anonKey: 'anon' };
const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const ALL_REASONS: RoundLinkReason[] = [
  'linked',
  'match',
  'no_round',
  'no_season',
  'no_event',
  'event_taken',
  'several_events',
  'several_rounds',
  'season_locked',
];

describe('round_event_matches codes', () => {
  it('the migration returns exactly the codes the site knows', () => {
    const sql = readFileSync('supabase/migrations/20261112120000_round_auto_link.sql', 'utf8');
    const body = sql.slice(sql.indexOf('create function public.round_event_matches'));
    const codes = new Set([...body.matchAll(/(?:then|else) '([a-z_]+)'/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([...ALL_REASONS].sort());
  });

  it('every code has its own plain-English reason', () => {
    const texts = ALL_REASONS.map((code) => describeLinkReason(code));
    for (const [i, text] of texts.entries()) {
      expect(text, ALL_REASONS[i]).toBeTruthy();
      expect(text, ALL_REASONS[i]).not.toBe(ALL_REASONS[i]);
    }
    expect(new Set(texts).size).toBe(ALL_REASONS.length);
  });

  it('shows an unknown code as it is and nothing for no code', () => {
    expect(describeLinkReason('brand_new_code')).toBe('brand_new_code');
    expect(describeLinkReason(null)).toBeNull();
  });
});

describe('getRoundLinkReasons', () => {
  it('asks the database for the given rounds and keys the codes by round', async () => {
    let body: unknown = null;
    let calledUrl = '';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      body = JSON.parse(String(init?.body));
      return Response.json([
        { subsession_id: 89665306, event_id: null, reason: 'several_rounds' },
        { subsession_id: 89833865, event_id: 'e8', reason: 'match' },
      ]);
    }) as unknown as typeof fetch;

    const reasons = await getRoundLinkReasons(env, [89665306, 89833865]);
    expect(calledUrl).toBe('https://example.invalid/rest/v1/rpc/round_event_matches');
    expect(body).toEqual({ p_subsession_ids: [89665306, 89833865] });
    expect(reasons.get(89665306)).toBe('several_rounds');
    expect(reasons.get(89833865)).toBe('match');
  });

  it('makes no request for no rounds', async () => {
    globalThis.fetch = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    expect((await getRoundLinkReasons(env, [])).size).toBe(0);
  });

  it('throws when the database refuses', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(getRoundLinkReasons(env, [1])).rejects.toThrow(/round_event_matches/);
  });
});

describe('getOrphanedRounds', () => {
  const orphan = {
    subsession_id: 89152912,
    start_time: '2026-10-05T23:00:17Z',
    track_name: 'Circuit de Lédenon',
    layout: null,
    season_label: 'ATC18',
    season_id: null,
    event_id: null,
    format: 'sprint',
  };

  function stub(rpc: () => Response) {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/rpc/round_event_matches')) return rpc();
      if (url.includes('curated_rounds?')) return Response.json([orphan]);
      if (url.includes('race_score_results_public?')) return Response.json([]);
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
  }

  it('carries each round its reason and league-local date', async () => {
    stub(() => Response.json([{ subsession_id: 89152912, event_id: null, reason: 'event_taken' }]));
    const [round] = await getOrphanedRounds(env);
    expect(round.linkReason).toBe('event_taken');
    expect(round.localDate).toBe('2026-10-05');
    expect(round.scored).toBe(false);
  });

  it('still lists the rounds when the reasons cannot be read', async () => {
    const logged = console.error;
    console.error = () => {};
    try {
      stub(() => new Response('function not found', { status: 404 }));
      const rounds = await getOrphanedRounds(env);
      expect(rounds).toHaveLength(1);
      expect(rounds[0].linkReason).toBeNull();
    } finally {
      console.error = logged;
    }
  });
});

describe('suggestEvent', () => {
  const round = (over: Partial<OrphanRound> = {}): OrphanRound => ({
    subsession_id: 1,
    start_time: '2026-11-03T00:00:11Z',
    track_name: 'Sonoma Raceway',
    layout: null,
    season_label: 'ATC18',
    season_id: null,
    event_id: null,
    format: 'sprint',
    scored: false,
    localDate: '2026-11-02',
    linkReason: null,
    ...over,
  });
  const event = (id: string, circuit: string, date: string) =>
    ({ id, event_date: date, circuits: { name: circuit, logo_url: null } }) as unknown as EventWithCircuit;

  it('picks the one event on the same circuit and league-local date', () => {
    const events = [event('a', 'Sonoma Raceway', '2026-11-02'), event('b', 'Sonoma Raceway', '2026-11-03')];
    expect(suggestEvent(round(), events)?.id).toBe('a');
  });

  it('matches the circuit name without regard to case', () => {
    expect(
      suggestEvent(round({ track_name: 'SONOMA RACEWAY' }), [event('a', 'Sonoma Raceway', '2026-11-02')])?.id,
    ).toBe('a');
  });

  it('never guesses between two events, and finds none on another circuit', () => {
    const two = [event('a', 'Sonoma Raceway', '2026-11-02'), event('b', 'Sonoma Raceway', '2026-11-02')];
    expect(suggestEvent(round(), two)).toBeNull();
    expect(suggestEvent(round(), [event('c', 'Road America', '2026-11-02')])).toBeNull();
  });
});
