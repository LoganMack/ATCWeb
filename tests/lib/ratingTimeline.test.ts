/**
 * The Series iRating shared timeline (U2, NFR7.3): the pure slot builder, its 5 ms ceiling, and the
 * getRatingTimeline read (its three requests in one wave, the encoded select, the caller's token, the
 * broadcaster filter, U1's exclusion rule and failing closed). PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimelineSlots, isMainSeasonName, type TimelineRoundRow } from '../../src/lib/rating/timeline';
import { getRatingTimeline, RATING_TIMELINE_SELECT } from '../../src/lib/db/seriesRatings';
import { ROUND_EVENT_CATEGORY_SELECT } from '../../src/lib/results/roundEligibility';
import embedReads from '../../src/lib/embedReads.json';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };
const ROUNDS_PATH =
  `curated_rounds?select=${encodeURIComponent(RATING_TIMELINE_SELECT)}` +
  '&subsession_id=gt.0&season_id=not.is.null&order=start_time.asc,subsession_id.asc';
const EXHIBITION_PATH = 'round_overrides?select=subsession_id&is_exhibition=eq.true';
const TEST_PATH = 'round_overrides?select=subsession_id&is_test=eq.true';

function round(id: number, season: string | null, over: Partial<TimelineRoundRow> = {}): TimelineRoundRow {
  return {
    subsession_id: id,
    season: season === null ? null : { name: season },
    event: null,
    pinned_events: [],
    ...over,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Answers {
  rounds?: unknown;
  exhibition?: number[];
  test?: number[];
  status?: { rounds?: number; exhibition?: number; test?: number };
}

/** Stubs fetch with one answer per call kind, and records every raw URL and its headers. */
function stubFetch(answers: Answers) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers ?? {} });
    const which = url.includes('is_exhibition=eq.true')
      ? 'exhibition'
      : url.includes('is_test=eq.true')
        ? 'test'
        : 'rounds';
    const status = answers.status?.[which] ?? 200;
    if (status !== 200) return new Response('boom', { status });
    const body =
      which === 'rounds'
        ? (answers.rounds ?? [])
        : (answers[which] ?? []).map((subsession_id) => ({ subsession_id }));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return calls;
}

describe('buildTimelineSlots', () => {
  const rows = [
    round(101, 'ATC1'),
    round(102, 'ATC1'),
    round(150, 'ATC1'),
    round(201, 'ATC2'),
    round(301, 'ATC3'),
  ];

  it('keeps the order it was given and maps each row to { i, s }', () => {
    expect(buildTimelineSlots(rows, new Set())).toEqual([
      { i: 101, s: 'ATC1' },
      { i: 102, s: 'ATC1' },
      { i: 150, s: 'ATC1' },
      { i: 201, s: 'ATC2' },
      { i: 301, s: 'ATC3' },
    ]);
    const reversed = [...rows].reverse();
    expect(buildTimelineSlots(reversed, new Set()).map((s) => s.i)).toEqual([301, 201, 150, 102, 101]);
  });

  it('leaves out rounds of side series and exhibition seasons, keeping only ATCn seasons', () => {
    const mixed = [
      round(101, 'ATC4'),
      round(102, 'ATC4 Off-Season Fun Series'),
      round(103, 'ATC Exhibitions'),
      round(104, 'LCC1'),
      round(105, 'ATC5'),
    ];
    expect(buildTimelineSlots(mixed, new Set())).toEqual([
      { i: 101, s: 'ATC4' },
      { i: 105, s: 'ATC5' },
    ]);
  });

  it('recognises only ATC plus a number as a main season', () => {
    for (const name of ['ATC1', 'ATC18', ' ATC21 ']) expect(isMainSeasonName(name), name).toBe(true);
    for (const name of ['ATC Exhibitions', 'ATC4 Off-Season Fun Series', 'LCC1', 'atc5', 'ATC', '', null])
      expect(isMainSeasonName(name), String(name)).toBe(false);
  });

  it('drops the excluded ids and never changes its inputs', () => {
    const excluded = new Set([150, 999]);
    const copy = JSON.parse(JSON.stringify(rows));
    expect(buildTimelineSlots(rows, excluded).map((s) => s.i)).toEqual([101, 102, 201, 301]);
    expect(rows).toEqual(copy);
    expect([...excluded]).toEqual([150, 999]);
  });

  it('leaves out a round with no season', () => {
    expect(buildTimelineSlots([round(201, null)], new Set())).toEqual([]);
  });

  it('gives a round with no rating points its slot anyway (it knows nothing of ratings)', () => {
    // 102 has no history points in any driver's chart; it still takes a slot.
    expect(buildTimelineSlots([round(101, 'ATC1'), round(102, 'ATC1')], new Set())).toHaveLength(2);
  });

  it('gives an empty list for no rows', () => {
    expect(buildTimelineSlots([], new Set())).toEqual([]);
  });

  it('builds 1,000 rows in under 5 ms (best of 3, NFR1.5)', () => {
    const many = Array.from({ length: 1000 }, (_, k) => round(k + 1, `ATC${Math.floor(k / 16) + 1}`));
    const excluded = new Set(many.filter((_, k) => k % 10 === 0).map((r) => r.subsession_id));
    let best = Infinity;
    let slots: ReturnType<typeof buildTimelineSlots> = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      slots = buildTimelineSlots(many, excluded);
      best = Math.min(best, performance.now() - start);
    }
    expect(slots).toHaveLength(900);
    expect(best).toBeLessThan(5);
  });

  it('keeps 300 slots with real-sized subsession ids under 9,000 bytes of JSON (NFR1)', () => {
    // Eight-digit iRacing subsession ids and ATCn season names (the only ones kept), about 16 rounds a season.
    const rounds = Array.from({ length: 300 }, (_, k) =>
      round(80_000_000 + k * 1_237, `ATC${Math.floor(k / 16) + 1}`),
    );
    const json = JSON.stringify(buildTimelineSlots(rounds, new Set()));
    expect(JSON.parse(json)).toHaveLength(300);
    expect(new TextEncoder().encode(json).length).toBeLessThan(9000);
  });
});

describe('getRatingTimeline', () => {
  it('sends the rounds read and the two override reads, the select encoded once', async () => {
    const calls = stubFetch({});
    await getRatingTimeline(env);
    expect(calls).toHaveLength(3);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain(`${env.url}/rest/v1/${ROUNDS_PATH}`);
    expect(urls).toContain(`${env.url}/rest/v1/${EXHIBITION_PATH}`);
    expect(urls).toContain(`${env.url}/rest/v1/${TEST_PATH}`);
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer anon-key');
  });

  it('reads as the signed-in viewer when the env carries a token', async () => {
    const calls = stubFetch({});
    await getRatingTimeline({ ...env, accessToken: 'viewer-jwt' });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer viewer-jwt');
  });

  it('leaves a broadcaster’s hidden rounds out of the rounds read (NFR3.1)', async () => {
    const calls = stubFetch({});
    await getRatingTimeline({ ...env, hiddenSubsessionIds: [42] });
    const roundsCall = calls.find((c) => c.url.includes('curated_rounds?'));
    expect(roundsCall?.url).toBe(`${env.url}/rest/v1/${ROUNDS_PATH}&subsession_id=not.in.(42)`);
  });

  it('sends all three reads before any answers (NFR1.1)', async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    globalThis.fetch = ((input: string) => {
      seen.push(String(input));
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response('[]', { status: 200 })));
      });
    }) as typeof fetch;
    const pending = getRatingTimeline(env);
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(3));
    } finally {
      for (const release of releases) release();
    }
    await expect(pending).resolves.toEqual([]);
  });

  it('leaves out test and exhibition rounds by U1’s rule and keeps the answered order', async () => {
    stubFetch({
      rounds: [
        round(101, 'ATC1'),
        round(102, 'ATC1', { event: { category: 'exhibition' } }),
        round(103, 'ATC1', { event: null, pinned_events: [{ category: 'test' }] }),
        round(201, 'ATC2', {
          event: { category: 'championship' },
          pinned_events: [{ category: 'exhibition' }],
        }),
        round(202, 'ATC2'),
        round(203, 'ATC2'),
      ],
      test: [202],
    });
    expect(await getRatingTimeline(env)).toEqual([
      { i: 101, s: 'ATC1' },
      { i: 201, s: 'ATC2' },
      { i: 203, s: 'ATC2' },
    ]);
  });

  it('rejects when any of the three reads fails, so the fragment shows its error (NFR3.5, BR1.9)', async () => {
    for (const status of [{ rounds: 500 }, { exhibition: 500 }, { test: 500 }]) {
      stubFetch({ status });
      await expect(getRatingTimeline(env), JSON.stringify(status)).rejects.toThrow(
        /Supabase REST error 500 on /,
      );
    }
  });
});

describe('RATING_TIMELINE_SELECT', () => {
  it('is the embedReads.json select, ending with U1’s category embeds', () => {
    expect(RATING_TIMELINE_SELECT).toBe(
      'subsession_id,season:seasons!curated_rounds_season_id_fkey(name),event:events!curated_rounds_event_id_fkey(category),pinned_events:events!events_subsession_id_fkey(category)',
    );
    expect(RATING_TIMELINE_SELECT).toBe(embedReads.ratingTimelineRounds.select);
    expect(RATING_TIMELINE_SELECT.endsWith(`,${ROUND_EVENT_CATEGORY_SELECT}`)).toBe(true);
  });
});
