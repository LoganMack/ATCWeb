/**
 * Past results on the Event Briefing and the Stats > Circuits layout row (past-results U8): the test and
 * exhibition read, the exclusion helpers, the dates, the order, the popup data and the CPU guard. fetch is
 * stubbed; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSupabaseEnv, type SupabaseEnv } from '../../src/lib/db/client';
import { getStandingsExcludedRoundIds } from '../../src/lib/db/rounds';
import type { IncidentRow } from '../../src/lib/incidents';
import { incidentSummariesJson, incidentSummaryMap } from '../../src/lib/incidentDisplay';
import { RequestMemo } from '../../src/lib/requestMemo';
import { safeJson } from '../../src/lib/security';
import { ROUND_EVENT_CATEGORY_SELECT } from '../../src/lib/results/roundEligibility';
import type { DriverBasic } from '../../src/lib/results/rows';
import {
  PAST_RESULTS_ROUND_EVENTS_SELECT,
  buildLayoutHighlights,
  formatPastResultDate,
  getLayoutExcludedRoundIds,
  layoutHighlightGroups,
  withoutExcludedRoundRows,
  withoutExcludedRounds,
  type LayoutHighlights,
  type LayoutRoundSummary,
  type RaceOneCuratedRow,
  type RaceOneScoreRow,
} from '../../src/lib/results/layouts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const RUNTIME = {
  env: { PUBLIC_SUPABASE_URL: 'https://db.example.test', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' },
};

function envFor(token?: string): SupabaseEnv {
  const session = token ? { user: { id: 'u1' }, profile: null, accessToken: token } : null;
  return resolveSupabaseEnv({
    runtime: RUNTIME,
    session,
    viewAsVisitor: false,
    memo: new RequestMemo(),
  } as unknown as App.Locals);
}

interface Call {
  url: URL;
  table: string;
  select: string;
  apikey: string | null;
  auth: string | null;
}

type Kind = 'category' | 'exhibition' | 'test' | 'other';

function kindOf(call: Call): Kind {
  if (call.table === 'curated_rounds' && call.select === PAST_RESULTS_ROUND_EVENTS_SELECT) return 'category';
  if (call.url.search.includes('is_exhibition=eq.true')) return 'exhibition';
  if (call.url.search.includes('is_test=eq.true')) return 'test';
  return 'other';
}

interface Answers {
  category?: unknown[];
  exhibition?: number[];
  test?: number[];
  fail?: Kind;
}

/** Records every REST call and answers by kind; `fail` gives that kind a 500. */
function stubFetch(answers: Answers = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      table: url.pathname.split('/rest/v1/')[1],
      select: url.searchParams.get('select') ?? '',
      apikey: headers.get('apikey'),
      auth: headers.get('Authorization'),
    };
    calls.push(call);
    const kind = kindOf(call);
    if (kind === answers.fail) return new Response('upstream failure', { status: 500 });
    const body =
      kind === 'category'
        ? (answers.category ?? [])
        : kind === 'exhibition'
          ? (answers.exhibition ?? []).map((id) => ({ subsession_id: id }))
          : kind === 'test'
            ? (answers.test ?? []).map((id) => ({ subsession_id: id }))
            : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const round = (id: number, event: string | null, pinned: string[] = []) => ({
  subsession_id: id,
  event: event === null ? null : { category: event },
  pinned_events: pinned.map((category) => ({ category })),
});

describe('getLayoutExcludedRoundIds (NFR7.3)', () => {
  it('reads nothing for no rounds and returns an empty set', async () => {
    const calls = stubFetch();
    const out = await getLayoutExcludedRoundIds(envFor(), []);
    expect(calls).toHaveLength(0);
    expect(out).toEqual(new Set());
  });

  it('makes exactly 3 calls for 3 rounds: 1 category read and 2 override reads', async () => {
    const calls = stubFetch();
    await getLayoutExcludedRoundIds(envFor(), [1, 2, 3]);
    expect(calls.map(kindOf).sort()).toEqual(['category', 'exhibition', 'test']);
  });

  it('excludes a linked exhibition round, a pinned-only test round and an override-only round', async () => {
    stubFetch({
      category: [round(1, 'exhibition'), round(2, null, ['test']), round(3, 'championship'), round(4, null)],
      exhibition: [4],
    });
    const out = await getLayoutExcludedRoundIds(envFor(), [1, 2, 3, 4]);
    expect([...out].sort()).toEqual([1, 2, 4]);
  });

  it('keeps a linked championship round even when a pinned event is an exhibition (U1 BR1.4)', async () => {
    stubFetch({ category: [round(5, 'championship', ['exhibition'])] });
    const out = await getLayoutExcludedRoundIds(envFor(), [5]);
    expect(out.has(5)).toBe(false);
  });

  it('excludes an id missing from the category response when it has a test override', async () => {
    stubFetch({ category: [round(6, 'championship')], test: [7] });
    const out = await getLayoutExcludedRoundIds(envFor(), [6, 7]);
    expect([...out]).toEqual([7]);
  });

  it.each(['category', 'exhibition', 'test'] as const)(
    'rejects when the %s read fails (NFR3.6)',
    async (fail) => {
      stubFetch({ fail });
      await expect(getLayoutExcludedRoundIds(envFor(), [1, 2])).rejects.toThrow(/Supabase REST error 500/);
    },
  );
});

describe('requests (NFR7.8, NFR1.1 to NFR1.4, NFR3.1)', () => {
  it('issues all 3 calls before any of them resolves', async () => {
    const held: Array<() => void> = [];
    let seen = 0;
    let seenAtRelease: number | null = null;
    const release = () => {
      if (seenAtRelease === null) seenAtRelease = seen;
      held.splice(0).forEach((resolve) => resolve());
    };
    globalThis.fetch = (async () => {
      seen += 1;
      const wait = new Promise<void>((resolve) => held.push(resolve));
      if (seen === 3 || seenAtRelease !== null) release();
      await wait;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    // Always release after a short wait, so a serial implementation fails instead of hanging.
    const fallback = setTimeout(release, 200);
    try {
      await getLayoutExcludedRoundIds(envFor(), [1, 2, 3]);
    } finally {
      clearTimeout(fallback);
    }
    expect(seenAtRelease).toBe(3);
  });

  it('adds only the category call once the override set has been read on the same env', async () => {
    const calls = stubFetch();
    const env = envFor();
    await getStandingsExcludedRoundIds(env);
    expect(calls).toHaveLength(2);
    await getLayoutExcludedRoundIds(env, [1, 2]);
    expect(calls).toHaveLength(3);
    expect(kindOf(calls[2])).toBe('category');
  });

  it('reads curated_rounds with the encoded select, the passed ids only and a stable order', async () => {
    const calls = stubFetch();
    await getLayoutExcludedRoundIds(envFor(), [101, 202, 303]);
    const category = calls.find((c) => kindOf(c) === 'category')!;
    expect(category.table).toBe('curated_rounds');
    const raw = category.url.search.slice(1).split('&');
    expect(raw).toContain(`select=${encodeURIComponent(PAST_RESULTS_ROUND_EVENTS_SELECT)}`);
    const filters = raw.filter((p) => !p.startsWith('select=') && !p.startsWith('order='));
    expect(filters).toEqual(['subsession_id=in.(101,202,303)']);
    expect(raw).toContain('order=subsession_id.asc');
  });

  it('sends the anon key when signed out and the viewer’s token when signed in', async () => {
    const anonCalls = stubFetch();
    await getLayoutExcludedRoundIds(envFor(), [1]);
    for (const c of anonCalls) {
      expect(c.apikey).toBe('anon-key');
      expect(c.auth).toBe('Bearer anon-key');
    }
    const viewerCalls = stubFetch();
    await getLayoutExcludedRoundIds(envFor('viewer-jwt'), [1]);
    for (const c of viewerCalls) {
      expect(c.apikey).toBe('anon-key');
      expect(c.auth).toBe('Bearer viewer-jwt');
    }
  });
});

describe('select', () => {
  it('is the round id plus the shared category select', () => {
    expect(PAST_RESULTS_ROUND_EVENTS_SELECT).toBe('subsession_id,' + ROUND_EVENT_CATEGORY_SELECT);
  });
});

const PLACEHOLDER = '—';

describe('formatPastResultDate (NFR7.1, AC6.1.1, AC6.1.2)', () => {
  it('reads "MMM DD, YYYY" with a two-digit day', () => {
    expect(formatPastResultDate('2026-11-03T22:40:00Z')).toBe('Nov 03, 2026');
    expect(formatPastResultDate('2027-01-01T20:00:00Z')).toBe('Jan 01, 2027');
  });

  it('keeps a bare calendar day on that day', () => {
    expect(formatPastResultDate('2026-11-03')).toBe('Nov 03, 2026');
  });

  it('uses the league’s calendar day, not UTC’s', () => {
    expect(formatPastResultDate('2026-11-04T02:00:00Z')).toBe('Nov 03, 2026');
  });

  it('gives the placeholder for a missing or bad date', () => {
    expect(formatPastResultDate(null)).toBe(PLACEHOLDER);
    expect(formatPastResultDate('')).toBe(PLACEHOLDER);
    expect(formatPastResultDate('not a date')).toBe(PLACEHOLDER);
  });
});

// --- Highlight fixtures ---------------------------------------------------------------------------------

const ALPHA = 1;
const GAMMA = 2;

const driverOf = (id: string, custId: number) => ({ id, name: id, iracing_cust_id: custId }) as DriverBasic;

const roundOf = (subsessionId: number, startTime: string): LayoutRoundSummary => ({
  subsessionId,
  trackName: 'Lime Rock',
  startTime,
  seasonLabel: 'ATC18',
  displayRoundNumber: 1,
});

const score = (
  subsession_id: number,
  race_number: number,
  driver_id: string,
  class_id: number,
  shown_position: number,
): RaceOneScoreRow => ({
  subsession_id,
  race_number,
  driver_id,
  class_id,
  shown_position,
  classified: true,
  dsq: false,
});

const orderDrivers = [driverOf('a1', 101), driverOf('a2', 102), driverOf('g1', 201)];
const OLD = roundOf(10, '2026-06-14T22:00:00Z');
const NEW = roundOf(20, '2026-11-03T22:00:00Z');
const NEW_TWIN = roundOf(21, '2026-11-03T22:00:00Z');

function threeRaceScores(sub: number): RaceOneScoreRow[] {
  return [1, 2, 3].flatMap((race) => [
    score(sub, race, race === 2 ? 'a2' : 'a1', ALPHA, 1),
    score(sub, race, race === 2 ? 'a1' : 'a2', ALPHA, 2),
    score(sub, race, 'g1', GAMMA, 3),
  ]);
}
const grid = (sub: number): RaceOneCuratedRow[] => [
  { subsession_id: sub, cust_id: 101, starting_position: 1 },
  { subsession_id: sub, cust_id: 102, starting_position: 2 },
  { subsession_id: sub, cust_id: 201, starting_position: 3 },
];

function orderHighlights(): LayoutHighlights {
  const rounds = [OLD, NEW, NEW_TWIN];
  const scores = [...threeRaceScores(10), ...threeRaceScores(20), ...threeRaceScores(21)];
  return buildLayoutHighlights(rounds, orderDrivers, scores, [...grid(10), ...grid(20), ...grid(21)], true);
}

const keyOf = (e: { round: LayoutRoundSummary; raceNumber: number }) =>
  `${e.round.subsessionId}:${e.raceNumber}`;

describe('highlight order (NFR7.2, AC6.2.1, AC6.2.2)', () => {
  const h = orderHighlights();

  it('lists Race 3, 2, 1 inside a round, in the class and the overall lists', () => {
    const alpha = h.winnersByClass.get(ALPHA)!.filter((w) => w.round.subsessionId === 20);
    expect(alpha.map((w) => w.raceNumber)).toEqual([3, 2, 1]);
    const overall = h.overallWinners.filter((w) => w.round.subsessionId === 20);
    expect(overall.map((w) => w.raceNumber)).toEqual([3, 2, 1]);
  });

  it('puts every race of the newer round before every race of the older one', () => {
    const subs = h.winnersByClass.get(ALPHA)!.map((w) => w.round.subsessionId);
    expect(subs.lastIndexOf(20)).toBeLessThan(subs.indexOf(10));
    expect(subs.lastIndexOf(21)).toBeLessThan(subs.indexOf(10));
  });

  it('lists the higher subsession id first when two rounds start together', () => {
    expect(h.overallWinners.map(keyOf)).toEqual([
      '21:3',
      '21:2',
      '21:1',
      '20:3',
      '20:2',
      '20:1',
      '10:3',
      '10:2',
      '10:1',
    ]);
  });

  it('keeps one pole per round, newest first', () => {
    expect(h.overallPoles.map((p) => p.round.subsessionId)).toEqual([21, 20, 10]);
    expect(h.polesByClass.get(ALPHA)!.map((p) => p.round.subsessionId)).toEqual([21, 20, 10]);
  });
});

describe('withoutExcludedRounds (NFR7.3, AC6.4.1 to AC6.4.3)', () => {
  it('removes every winner and pole of an excluded round and keeps the rest in order', () => {
    const h = orderHighlights();
    const out = withoutExcludedRounds(h, new Set([20]));
    const all = [
      ...out.overallWinners,
      ...out.overallPoles,
      ...[...out.winnersByClass.values()].flat(),
      ...[...out.polesByClass.values()].flat(),
    ];
    expect(all.some((e) => e.round.subsessionId === 20)).toBe(false);
    expect(out.overallWinners.map(keyOf)).toEqual(
      h.overallWinners.map(keyOf).filter((k) => !k.startsWith('20:')),
    );
    expect(out.winnersByClass.get(GAMMA)!.map(keyOf)).toEqual(
      h.winnersByClass
        .get(GAMMA)!
        .map(keyOf)
        .filter((k) => !k.startsWith('20:')),
    );
  });

  it('leaves the input unchanged', () => {
    const h = orderHighlights();
    const before = {
      overallWinners: h.overallWinners.map(keyOf),
      overallPoles: h.overallPoles.map(keyOf),
      alpha: h.winnersByClass.get(ALPHA)!.map(keyOf),
      alphaPoles: h.polesByClass.get(ALPHA)!.map(keyOf),
    };
    withoutExcludedRounds(h, new Set([10, 20, 21]));
    expect({
      overallWinners: h.overallWinners.map(keyOf),
      overallPoles: h.overallPoles.map(keyOf),
      alpha: h.winnersByClass.get(ALPHA)!.map(keyOf),
      alphaPoles: h.polesByClass.get(ALPHA)!.map(keyOf),
    }).toEqual(before);
  });

  it('gives empty lists and no groups when the layout’s only round is excluded', () => {
    const h = buildLayoutHighlights([OLD], orderDrivers, threeRaceScores(10), grid(10), true);
    const out = withoutExcludedRounds(h, new Set([10]));
    expect(out.overallWinners).toEqual([]);
    expect(out.overallPoles).toEqual([]);
    for (const list of out.winnersByClass.values()) expect(list).toEqual([]);
    for (const list of out.polesByClass.values()) expect(list).toEqual([]);
    const classes = [
      { id: ALPHA, name: 'Alpha' },
      { id: GAMMA, name: 'Gamma' },
    ];
    expect(layoutHighlightGroups(out, classes)).toEqual([]);
  });
});

// --- Incident fixtures ----------------------------------------------------------------------------------

function incident(id: string, subsessionId: number, extra: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id,
    subsessionId,
    seasonLabel: 'ATC18',
    displayRoundNumber: 3,
    trackName: 'Lime Rock',
    startTime: '2026-11-03T22:00:00Z',
    sessionType: 'race',
    raceNumber: 1,
    incidentNumber: '4',
    lap: 7,
    driver: { ...driverOf('a1', 101), car_number: 12 },
    involvedDrivers: [],
    offenseIds: [],
    offenseNames: ['Avoidable contact'],
    penaltyPoints: 2,
    timePenaltySeconds: null,
    pointsPenalty: 0,
    isWarning: false,
    isAppealed: false,
    description: 'Contact at turn 1',
    createdAt: '2026-11-04T10:00:00Z',
    ...extra,
  };
}

describe('withoutExcludedRoundRows (NFR7.3)', () => {
  it('drops past rounds and incidents of excluded rounds, including a pinned-test-only round, in order', async () => {
    stubFetch({
      category: [round(10, 'championship'), round(20, null, ['test']), round(30, 'championship')],
    });
    const excluded = await getLayoutExcludedRoundIds(envFor(), [30, 20, 10]);
    expect([...excluded]).toEqual([20]);

    const pastRounds = [roundOf(30, '2026-12-01T00:00:00Z'), NEW, OLD];
    expect(withoutExcludedRoundRows(pastRounds, excluded).map((r) => r.subsessionId)).toEqual([30, 10]);

    const rows = [incident('i1', 30), incident('i2', 20), incident('i3', 10), incident('i4', 30)];
    expect(withoutExcludedRoundRows(rows, excluded).map((r) => r.id)).toEqual(['i1', 'i3', 'i4']);
    expect(rows).toHaveLength(4);
  });
});

describe('incident popup data (NFR7.4)', () => {
  const rows = [
    incident('i1', 10, { description: 'Dove in </script><b>&    ' }),
    incident('i2', 10, {
      driver: { ...driverOf('h1', -1), name: 'Hidden Driver', car_number: 44, is_hidden: true },
    }),
    incident('i3', 20, { driver: null }),
  ];

  it('escapes <, >, &, U+2028 and U+2029 and parses back to the map (NFR3.4)', () => {
    const json = safeJson(incidentSummaryMap(rows));
    for (const ch of ['<', '>', '&', ' ', ' ']) expect(json).not.toContain(ch);
    expect(JSON.parse(json)).toEqual(incidentSummaryMap(rows));
  });

  it('parses equal to the old block (NFR2.3)', () => {
    expect(JSON.parse(safeJson(incidentSummaryMap(rows)))).toEqual(JSON.parse(incidentSummariesJson(rows)));
  });

  it('keeps a hidden driver masked (NFR3.3)', () => {
    expect(incidentSummaryMap(rows).i2.driver).toBe('#44 Hidden Driver');
  });

  it('holds exactly the shown rows (NFR1.6)', () => {
    expect(Object.keys(JSON.parse(safeJson(incidentSummaryMap(rows))))).toEqual(['i1', 'i2', 'i3']);
  });
});

describe('cpu guard (NFR1.7, NFR7.8)', () => {
  const classes = [ALPHA, GAMMA, 3];
  const drivers = Array.from({ length: 40 }, (_, i) => driverOf(`d${i}`, 1000 + i));
  const rounds = Array.from({ length: 20 }, (_, i) =>
    roundOf(100 + i, `2026-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}T22:00:00Z`),
  );
  const scoreRows: RaceOneScoreRow[] = rounds.flatMap((r) =>
    [1, 2, 3].flatMap((race) =>
      drivers.map((d, i) => score(r.subsessionId, race, d.id, classes[i % 3], ((i + race) % 40) + 1)),
    ),
  );
  const curatedRows: RaceOneCuratedRow[] = rounds.flatMap((r) =>
    drivers.map((d, i) => ({
      subsession_id: r.subsessionId,
      cust_id: d.iracing_cust_id!,
      starting_position: i + 1,
    })),
  );
  const excluded = new Set(rounds.slice(0, 5).map((r) => r.subsessionId));
  const incidents = Array.from({ length: 300 }, (_, i) => incident(`inc${i}`, rounds[i % 20].subsessionId));

  it('builds, filters and serialises a busy layout in under 5 ms (best of 3)', () => {
    expect(scoreRows).toHaveLength(2400);
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const highlights = buildLayoutHighlights(rounds, drivers, scoreRows, curatedRows, true);
      withoutExcludedRounds(highlights, excluded);
      withoutExcludedRoundRows(rounds, excluded);
      const kept = withoutExcludedRoundRows(incidents, excluded);
      safeJson(incidentSummaryMap(kept));
      timings.push(performance.now() - start);
    }
    expect(Math.min(...timings)).toBeLessThan(5);
  });

  it('looks each highlight entry up in the excluded set exactly once', () => {
    const highlights = buildLayoutHighlights(rounds, drivers, scoreRows, curatedRows, true);
    const entries =
      highlights.overallWinners.length +
      highlights.overallPoles.length +
      [...highlights.winnersByClass.values()].reduce((n, l) => n + l.length, 0) +
      [...highlights.polesByClass.values()].reduce((n, l) => n + l.length, 0);
    const has = vi.spyOn(Set.prototype, 'has');
    let lookups = -1;
    try {
      withoutExcludedRounds(highlights, excluded);
      lookups = has.mock.calls.length;
    } finally {
      has.mockRestore();
    }
    expect(entries).toBeGreaterThan(0);
    expect(lookups).toBe(entries);
  });
});
