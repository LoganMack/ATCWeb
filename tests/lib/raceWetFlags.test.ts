/**
 * EventCalendar's race wet flags (driver-splits U7: BR1.2, BR1.3, BR1.13, BR1.14; NFR3.1, NFR3.4, NFR7.2):
 * which races count as wet, which event a round takes its flags from, and the one curated_rounds read that
 * fetches them. fetch is stubbed and the raw request URL is kept, so the single encoding is pinned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getRaceWetFlagsForSubsessions,
  isWetRace,
  roundWetFlags,
  ROUND_WET_FLAGS_SELECT,
  type RaceWetFlags,
} from '../../src/lib/db/events';
import type { SupabaseEnv } from '../../src/lib/db/client';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const BASE = 'https://db.example.test/rest/v1/';
const anonEnv: SupabaseEnv = { url: 'https://db.example.test', anonKey: 'anon-key' };

interface RawCall {
  path: string;
  auth: string | null;
}

function stubFetch(answer: () => Response = () => new Response('[]', { status: 200 })): RawCall[] {
  const calls: RawCall[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      path: url.startsWith(BASE) ? url.slice(BASE.length) : url,
      auth: new Headers(init?.headers).get('Authorization'),
    });
    return answer();
  }) as unknown as typeof fetch;
  return calls;
}

const flags = (r1: boolean, r2: boolean, r3: boolean): RaceWetFlags => ({
  race1_wet_affected: r1,
  race2_wet_affected: r2,
  race3_wet_affected: r3,
});

describe('isWetRace (BR1.2)', () => {
  it('is true only for the race whose own flag is set', () => {
    expect([1, 2, 3].map((n) => isWetRace(flags(true, false, false), n))).toEqual([true, false, false]);
    expect([1, 2, 3].map((n) => isWetRace(flags(false, true, false), n))).toEqual([false, true, false]);
    expect([1, 2, 3].map((n) => isWetRace(flags(false, false, true), n))).toEqual([false, false, true]);
  });

  it('is false for a race number with no flag column', () => {
    expect(isWetRace(flags(true, true, true), 4)).toBe(false);
    expect(isWetRace(flags(true, true, true), 0)).toBe(false);
  });

  it('is false unless the flag is exactly true, and for missing flags', () => {
    expect(isWetRace(flags(false, false, false), 1)).toBe(false);
    const odd = (v: unknown) =>
      ({ ...flags(false, false, false), race1_wet_affected: v }) as unknown as RaceWetFlags;
    expect(isWetRace(odd(null), 1)).toBe(false);
    expect(isWetRace(odd('true'), 1)).toBe(false);
    expect(isWetRace(odd(1), 1)).toBe(false);
    expect(isWetRace(null, 1)).toBe(false);
    expect(isWetRace(undefined, 2)).toBe(false);
  });

  it('never counts practice or qualifying wet as a wet race (AC4.1.3)', () => {
    for (const key of ['practice_wet_affected', 'qualifying_wet_affected']) {
      const f = { ...flags(false, false, false), [key]: true } as unknown as RaceWetFlags;
      expect([1, 2, 3].map((n) => isWetRace(f, n))).toEqual([false, false, false]);
    }
  });
});

describe('roundWetFlags (BR1.3)', () => {
  it('takes the linked event over a pinned one with different values', () => {
    const row = {
      subsession_id: 1,
      linked: flags(false, true, false),
      pinned: [{ id: 'ffffffff-0000-0000-0000-000000000001', ...flags(true, false, true) }],
    };
    expect(roundWetFlags(row)).toEqual(flags(false, true, false));
  });

  it('falls back to the pinned event when nothing is linked', () => {
    const row = { subsession_id: 1, linked: null, pinned: [{ id: 'a', ...flags(true, false, false) }] };
    expect(roundWetFlags(row)).toEqual(flags(true, false, false));
  });

  it('takes the pinned event with the greatest id, whatever the array order', () => {
    const low = { id: 'aaaaaaaa-0000-0000-0000-000000000001', ...flags(false, false, false) };
    const high = { id: 'bbbbbbbb-0000-0000-0000-000000000001', ...flags(false, false, true) };
    expect(roundWetFlags({ subsession_id: 1, linked: null, pinned: [low, high] })).toEqual(
      flags(false, false, true),
    );
    expect(roundWetFlags({ subsession_id: 1, linked: null, pinned: [high, low] })).toEqual(
      flags(false, false, true),
    );
  });

  it('is null with no linked and no pinned event, and never returns an id', () => {
    expect(roundWetFlags({ subsession_id: 1, linked: null, pinned: [] })).toBeNull();
    expect(roundWetFlags({ subsession_id: 1, linked: null, pinned: null })).toBeNull();
    const result = roundWetFlags({
      subsession_id: 1,
      linked: null,
      pinned: [{ id: 'x', ...flags(true, true, true) }],
    });
    expect(result).not.toHaveProperty('id');
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'race1_wet_affected',
      'race2_wet_affected',
      'race3_wet_affected',
    ]);
  });
});

describe('getRaceWetFlagsForSubsessions (BR1.13, BR1.14; NFR3.1)', () => {
  it('makes no request for no subsessions', async () => {
    const calls = stubFetch();
    const result = await getRaceWetFlagsForSubsessions(anonEnv, []);
    expect(calls).toHaveLength(0);
    expect(result).toEqual(new Map());
  });

  it('makes one curated_rounds call with the select encoded once, as the caller', async () => {
    const calls = stubFetch();
    await getRaceWetFlagsForSubsessions(anonEnv, [3, 1]);
    await getRaceWetFlagsForSubsessions({ ...anonEnv, accessToken: 'viewer-jwt' }, [3, 1]);
    const expected = `curated_rounds?select=${encodeURIComponent(ROUND_WET_FLAGS_SELECT)}&subsession_id=in.(3,1)&order=subsession_id.asc`;
    expect(calls.map((c) => c.path)).toEqual([expected, expected]);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer anon-key', 'Bearer viewer-jwt']);
  });

  it('keeps the broadcaster filter on hidden rounds', async () => {
    const calls = stubFetch();
    await getRaceWetFlagsForSubsessions({ ...anonEnv, hiddenSubsessionIds: [42] }, [1]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path.endsWith('&subsession_id=not.in.(42)')).toBe(true);
  });

  it('maps each answered round to its flags', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify([
            { subsession_id: 1, linked: flags(true, false, false), pinned: [] },
            { subsession_id: 2, linked: null, pinned: [{ id: 'p', ...flags(false, true, false) }] },
            { subsession_id: 3, linked: null, pinned: [] },
          ]),
          { status: 200 },
        ),
    );
    const result = await getRaceWetFlagsForSubsessions(anonEnv, [1, 2, 3]);
    expect([...result]).toEqual([
      [1, flags(true, false, false)],
      [2, flags(false, true, false)],
      [3, null],
    ]);
  });

  it('rejects on a failed read, so the caller can tell no data from dry', async () => {
    stubFetch(() => new Response('upstream failure', { status: 500 }));
    await expect(getRaceWetFlagsForSubsessions(anonEnv, [1])).rejects.toThrow(
      /Supabase REST error 500 on curated_rounds/,
    );
  });
});

describe('the wet flags select', () => {
  it('is pinned, so an edit to embedReads.json shows up here', () => {
    expect(ROUND_WET_FLAGS_SELECT).toBe(
      'subsession_id,linked:events!curated_rounds_event_id_fkey(race1_wet_affected,race2_wet_affected,race3_wet_affected),pinned:events!events_subsession_id_fkey(id,race1_wet_affected,race2_wet_affected,race3_wet_affected)',
    );
  });
});
