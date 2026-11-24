/**
 * The driver page's race list: Start is the grid slot within the driver's class (from
 * curated_race_results.starting_position), Finish the shown position from race_score_results_public.
 * Shapes from driver 49a39606…, an Alpha driver: ATC18 Round 6 (89494354, unposted, laps down) and
 * ATC16 Round 1 (82494956, a normal finish).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classStartingPositions,
  getDriverRaceHistory,
  historyFinish,
  type ClassFieldRow,
  type DriverRaceHistoryRow,
} from '../../src/lib/results/raceHistory';
import { ROUND_WET_FLAGS_SELECT } from '../../src/lib/db/events';
import type { SupabaseEnv } from '../../src/lib/db/client';
import {
  classLeaders,
  classMarginText,
  marginSortValue,
  type ClassLeaderFieldRow,
} from '../../src/lib/results/classMargin';
import { formatMargin } from '../../src/lib/results/format';

const ALPHA = 1;
const GAMMA = 2;
const field = (sub: number, rows: [string, number, number | null][]): ClassFieldRow[] =>
  rows.map(([driver_id, class_id, starting_position]) => ({
    subsession_id: sub,
    race_number: 1,
    driver_id,
    class_id,
    starting_position,
  }));

describe('driver race list', () => {
  it('pins Start and Finish for a laps-down row on an unposted round', () => {
    // Overall: starts 1st, finishes 34th, 14 laps down; 5th of the Alpha drivers. Non-admins see the raw set.
    const starts = classStartingPositions(
      field(89494354, [
        ['me', ALPHA, 1],
        ['a2', ALPHA, 3],
        ['g1', GAMMA, 2],
        ['a3', ALPHA, null],
      ]),
    );
    expect(starts.get('89494354:1:me')).toBe(1);
    expect(starts.get('89494354:1:a2')).toBe(2);
    expect(starts.has('89494354:1:a3')).toBe(false);
    const finish = historyFinish({ position: 34, finish_position: 34, class_position: 5, dsq: false });
    expect(finish).toEqual({ finishPosition: 34, classPosition: 5 });
  });

  it('pins Start and Finish for a normal row, and counts a repeated field row once', () => {
    // Overall: starts 1st and finishes 4th; also 1st and 4th among Alpha.
    const rows = field(82494956, [
      ['me', ALPHA, 1],
      ['g1', GAMMA, 2],
      ['a2', ALPHA, 4],
      ['a2', ALPHA, 4],
      ['g2', GAMMA, 3],
    ]);
    const starts = classStartingPositions(rows);
    expect(starts.get('82494956:1:me')).toBe(1);
    expect(starts.get('82494956:1:a2')).toBe(2);
    expect(starts.get('82494956:1:g2')).toBe(2);
    expect(historyFinish({ position: 4, finish_position: 4, class_position: 4, dsq: false })).toEqual({
      finishPosition: 4,
      classPosition: 4,
    });
  });

  it('shows a DSQ at its finishing slot with no class position, as overall and class finish', () => {
    expect(historyFinish({ position: null, finish_position: 7, class_position: null, dsq: true })).toEqual({
      finishPosition: 7,
      classPosition: null,
    });
  });
});

describe('Races table Class margin (BR3.3, BR3.4)', () => {
  const scored = (
    driver_id: string,
    class_id: number,
    finish_position: number,
    dsq = false,
  ): ClassLeaderFieldRow => ({ subsession_id: 7, race_number: 1, driver_id, class_id, finish_position, dsq });
  const raw = (interval: number | null, laps: number) => ({
    interval_ten_thousandths: interval,
    laps_complete: laps,
  });

  it('measures the gap to the class leader, not the overall winner', () => {
    const leaders = classLeaders([scored('a1', ALPHA, 1), scored('g1', GAMMA, 3), scored('me', GAMMA, 5)]);
    expect(leaders.get(`7:1:${GAMMA}`)).toBe('g1');
    // Overall winner 0s, class leader +12.5s, me +20.0s on the same lap.
    expect(formatMargin(200_000, 20, 20)).toBe('20.000');
    expect(classMarginText(raw(200_000, 20), raw(125_000, 20), 20)).toBe('7.500');
  });

  it('skips a DSQ driver when picking the class leader, using the pre-penalty finish', () => {
    const leaders = classLeaders([
      scored('g1', GAMMA, 2, true),
      scored('g2', GAMMA, 4),
      scored('g3', GAMMA, 3),
    ]);
    expect(leaders.get(`7:1:${GAMMA}`)).toBe('g3');
  });

  it('can name an AI driver as class leader', () => {
    expect(classLeaders([scored('ai-1', GAMMA, 2), scored('me', GAMMA, 6)]).get(`7:1:${GAMMA}`)).toBe('ai-1');
  });

  it('counts laps down against the class leader, and falls back to the overall leader with no class leader', () => {
    // iRacing gives a lapped car a negative interval.
    expect(classMarginText(raw(-1, 18), raw(125_000, 20), 20)).toBe('-2L');
    expect(classMarginText(raw(200_000, 20), null, 20)).toBe(formatMargin(200_000, 20, 20));
    expect(classLeaders([scored('g1', GAMMA, 2, true)]).has(`7:1:${GAMMA}`)).toBe(false);
  });

  it('sorts margins: seconds by value, laps down after every timed gap, the leader last', () => {
    expect(marginSortValue('7.500')).toBe(7.5);
    expect(marginSortValue('-2L')).toBe(1_000_002);
    expect(marginSortValue('—')).toBeNull();
  });
});

/**
 * The Weather and Track Type fields (driver-splits U7: BR1.2, BR1.3, BR1.5, BR1.7, BR1.13; NFR1.1, NFR1.2,
 * NFR1.4, NFR2.2, NFR3.4, NFR7.4). fetch is stubbed; no network. Rounds: 100 on a one-layout oval (races 1
 * to 3, linked event with race 2 wet), 200 on a layout with no category, 300 on a layout with an unknown
 * category, 400 on a track with no circuit row (layout unresolved).
 */
describe('getDriverRaceHistory wet and category fields', () => {
  const blocked = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = blocked;
    vi.restoreAllMocks();
  });

  const DRIVER = '99999999-0000-0000-0000-000000000701';
  const CUST = 5150;
  const env: SupabaseEnv = { url: 'https://db.example.test', anonKey: 'anon-key' };
  const RACES: [number, number][] = [
    [100, 1],
    [100, 2],
    [100, 3],
    [200, 1],
    [300, 1],
    [400, 1],
  ];
  const TRACKS: Record<number, string> = {
    100: 'Oval Speedway',
    200: 'Road Park',
    300: 'Dirt Bowl',
    400: 'Nowhere Ring',
  };

  const score = ([sub, race]: [number, number]) => ({
    subsession_id: sub,
    race_number: race,
    driver_id: DRIVER,
    season_id: 's1',
    class_id: 1,
    team_id: null,
    finish_position: 2,
    classified: true,
    dsq: false,
    raw_position: 2,
    shown_set: 'raw',
    shown_position: 2,
    shown_class_position: 2,
    shown_finish_points: 0,
    shown_class_points: 0,
    shown_overall_total: 0,
    shown_class_total: 0,
  });
  const rawResult = ([sub, race]: [number, number]) => ({
    subsession_id: sub,
    race_number: race,
    cust_id: CUST,
    finish_position: 2,
    starting_position: 3,
    adjusted_position: null,
    incidents: 1,
    original_incidents: 1,
    laps_complete: 10,
    laps_led: 0,
    car_name: 'Car',
    interval_ten_thousandths: 1000,
  });
  const rounds = Object.entries(TRACKS).map(([sub, track_name], i) => ({
    subsession_id: Number(sub),
    season_id: 's1',
    start_time: `2026-0${i + 1}-01T00:00:00Z`,
    track_name,
    season_label: null,
    round_number: i + 1,
    format: null,
    strength_of_field: null,
    num_drivers: null,
  }));
  const circuits = [
    { id: 'c-oval', name: 'Oval Speedway', logo_url: null, location: null },
    { id: 'c-road', name: 'Road Park', logo_url: null, location: null },
    { id: 'c-dirt', name: 'Dirt Bowl', logo_url: null, location: null },
  ];
  const layout = (id: string, circuit_id: string, category: string | null) => ({
    id,
    circuit_id,
    name: 'Full',
    length_km: 2,
    lap_record_seconds: null,
    lap_record_holder: null,
    lap_record_date: null,
    image_url: null,
    corners: 4,
    category,
  });
  const layouts = [
    layout('l-oval', 'c-oval', 'oval'),
    layout('l-road', 'c-road', null),
    layout('l-dirt', 'c-dirt', 'dirt'),
  ];
  const wetRows = [
    {
      subsession_id: 100,
      linked: { race1_wet_affected: false, race2_wet_affected: true, race3_wet_affected: false },
      pinned: [],
    },
  ];

  interface Call {
    table: string;
    select: string;
  }
  const isWetCall = (c: Call) => c.table === 'curated_rounds' && c.select === ROUND_WET_FLAGS_SELECT;

  function body(table: string, select: string): unknown {
    if (table === 'race_score_results_public') return RACES.map(score);
    if (table === 'curated_race_results_shown') return RACES.map(rawResult);
    if (table === 'curated_rounds' && select === ROUND_WET_FLAGS_SELECT) return wetRows;
    if (table === 'curated_rounds' && select === 'subsession_id,layout')
      return Object.keys(TRACKS).map((s) => ({ subsession_id: Number(s), layout: null }));
    if (table === 'curated_rounds') return rounds;
    if (table === 'circuits') return circuits;
    if (table === 'circuit_layouts_shown') return layouts;
    return [];
  }

  /** Records each call; `wetStatus` answers the wet call with that status, `hold` delays the batch. */
  function stubFetch(opts: { wetStatus?: number; hold?: Promise<void> } = {}): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname.split('/rest/v1/')[1] + url.search);
      const table = path.split('?')[0];
      const select = url.searchParams.get('select') ?? '';
      const call = { table, select };
      calls.push(call);
      if (opts.hold && table !== 'race_score_results_public') await opts.hold;
      if (isWetCall(call) && opts.wetStatus && opts.wetStatus >= 400)
        return new Response('upstream failure', { status: opts.wetStatus });
      return new Response(JSON.stringify(body(table, select)), { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  const bySubRace = (rows: DriverRaceHistoryRow[]) =>
    Object.fromEntries(rows.map((r) => [`${r.subsessionId}:${r.raceNumber}`, r]));

  it('keeps a valid layout category and drops a null, unknown or unresolved one (BR1.7)', async () => {
    stubFetch();
    const rows = bySubRace(await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true }));
    expect(rows['100:1'].layoutCategory).toBe('oval');
    expect(rows['200:1'].layoutCategory).toBeNull();
    expect(rows['300:1'].layoutCategory).toBeNull();
    expect(rows['400:1'].layoutCategory).toBeNull();
  });

  it('marks only the race whose own flag is set, and a round with no event Dry (BR1.2, BR1.3)', async () => {
    const calls = stubFetch();
    const rows = bySubRace(await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true }));
    expect([rows['100:1'], rows['100:2'], rows['100:3']].map((r) => r.wetAffected)).toEqual([
      false,
      true,
      false,
    ]);
    expect(rows['200:1'].wetAffected).toBe(false);
    expect(calls.filter(isWetCall)).toHaveLength(1);
  });

  it('gives null wetAffected on a failed wet read, logs once without a name, and keeps the rest (BR1.5)', async () => {
    stubFetch();
    const good = await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch({ wetStatus: 500 });
    const failed = await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true });
    expect(failed.every((r) => r.wetAffected === null)).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(
      String(error.mock.calls[0][0]).startsWith('Failed to fetch wet flags for driver race history'),
    ).toBe(true);
    expect(JSON.stringify(error.mock.calls)).not.toContain(DRIVER);
    expect(failed.map(({ wetAffected: _w, ...rest }) => rest)).toEqual(
      good.map(({ wetAffected: _w, ...rest }) => rest),
    );
  });

  it('makes no wet call without the option, as the champions page calls it (BR1.13; NFR1.4)', async () => {
    const without = stubFetch();
    const rows = await getDriverRaceHistory(env, DRIVER, CUST);
    expect(without.filter(isWetCall)).toHaveLength(0);
    expect(rows.every((r) => r.wetAffected === null)).toBe(true);
    const withOption = stubFetch();
    await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true });
    expect(without.length).toBe(withOption.length - 1);
  });

  it('makes no wet call for a driver with no races', async () => {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string) => {
      const url = new URL(String(input));
      calls.push({ table: url.pathname.split('/rest/v1/')[1], select: url.searchParams.get('select') ?? '' });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true })).toEqual([]);
    expect(calls.filter(isWetCall)).toHaveLength(0);
    expect(calls.map((c) => c.table)).toEqual(['race_score_results_public']);
  });

  it('sends the wet read alongside the batch, not after it (NFR1.2)', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldResolved = false;
    void hold.then(() => {
      heldResolved = true;
    });
    const calls = stubFetch({ hold });
    const history = getDriverRaceHistory(env, DRIVER, CUST, { wetFlags: true });
    try {
      await vi.waitFor(() => expect(calls.some(isWetCall)).toBe(true));
      expect(heldResolved).toBe(false);
      // The rest of the batch is in flight at the same time.
      expect(calls.some((c) => c.table === 'curated_race_results_shown')).toBe(true);
    } finally {
      release();
    }
    const rows = await history;
    expect(rows).toHaveLength(RACES.length);
  });
});
