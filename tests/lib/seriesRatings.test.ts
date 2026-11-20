/**
 * The Series iRating read (src/lib/db/seriesRatings.ts; FR7, NFR2, NFR4, BR3.13): the request it sends to the
 * masked view, the order and trend cap it applies, the 5-race minimum, that a hidden driver's row never carries
 * an id, the class value fallback, and one driver's rating history read. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSeriesRatingHistory,
  getSeriesRatings,
  isRatingDriverKey,
  MIN_RATED_RACES,
  resolveRatingKind,
  shapeRatingHistory,
  shapeSeriesRatings,
  type RatingHistoryViewRow,
  type SeriesRatingViewRow,
} from '../../src/lib/db/seriesRatings';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };

function viewRow(over: Partial<SeriesRatingViewRow>): SeriesRatingViewRow {
  return {
    kind: 'overall',
    driver_key: 'k',
    name: 'Driver',
    linkable: true,
    driver_id: 'id-1',
    current: 1350,
    last_change: 0,
    minimum: 1350,
    maximum: 1350,
    races: 5,
    trend: [1350],
    ...over,
  };
}

function historyRow(over: Partial<RatingHistoryViewRow>): RatingHistoryViewRow {
  return {
    kind: 'overall',
    driver_key: 'h42',
    race_started_at: '2026-04-01T19:00:00+00:00',
    subsession_id: 4001,
    race_number: 1,
    round_races: 1,
    season_number: 18,
    season_name: 'ATC18',
    track_name: 'Spa',
    position: 3,
    field_size: 12,
    rating_after: 1416,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('shapeSeriesRatings', () => {
  it('orders by current rating, then races, then name', () => {
    const rows = shapeSeriesRatings([
      viewRow({ driver_key: 'a', name: 'Bea', current: 1400, races: 6 }),
      viewRow({ driver_key: 'b', name: 'Al', current: 1400, races: 6 }),
      viewRow({ driver_key: 'c', name: 'Cy', current: 1500, races: 5 }),
      viewRow({ driver_key: 'd', name: 'Di', current: 1400, races: 9 }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('keeps only the last 20 trend values (NFR2)', () => {
    const trend = Array.from({ length: 25 }, (_, i) => 1300 + i);
    const [row] = shapeSeriesRatings([viewRow({ trend })]);
    expect(row.trend).toHaveLength(20);
    expect(row.trend[0]).toBe(1305);
    expect(shapeSeriesRatings([viewRow({ trend: null })])[0].trend).toEqual([]);
  });

  it('drops the driver id unless the row is linkable, and names a nameless row Hidden Driver (NFR4)', () => {
    const [hidden, unlinked] = shapeSeriesRatings([
      viewRow({ driver_key: 'h4242', name: null, linkable: false, driver_id: null, current: 1500 }),
      viewRow({ driver_key: 'x', linkable: false, driver_id: 'id-2' }),
    ]);
    expect(hidden).toMatchObject({ key: 'h4242', name: 'Hidden Driver', driverId: null });
    expect(unlinked.driverId).toBeNull();
  });

  it('leaves out drivers with fewer than 5 races, so positions count only the drivers shown', () => {
    expect(MIN_RATED_RACES).toBe(5);
    const rows = shapeSeriesRatings([
      viewRow({ driver_key: 'top', current: 1600, races: 4 }),
      viewRow({ driver_key: 'a', current: 1500, races: 5 }),
      viewRow({ driver_key: 'b', current: 1400, races: 30 }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(shapeSeriesRatings([viewRow({ races: 1 })])).toEqual([]);
  });
});

describe('shapeRatingHistory', () => {
  it('keeps the date, season, track, race number in a multi-race round, position, field and rating', () => {
    expect(
      shapeRatingHistory([
        historyRow({}),
        historyRow({ race_number: 2, round_races: 2, rating_after: 1450 }),
        historyRow({ season_name: null, season_number: 17, track_name: null }),
        historyRow({ season_name: null, season_number: null }),
      ]),
    ).toEqual([
      { d: '2026-04-01', s: 'ATC18', t: 'Spa', r: 0, p: 3, f: 12, v: 1416 },
      { d: '2026-04-01', s: 'ATC18', t: 'Spa', r: 2, p: 3, f: 12, v: 1450 },
      { d: '2026-04-01', s: 'Season 17', t: '', r: 0, p: 3, f: 12, v: 1416 },
      { d: '2026-04-01', s: '', t: 'Spa', r: 0, p: 3, f: 12, v: 1416 },
    ]);
  });
});

describe('isRatingDriverKey', () => {
  it('accepts a stand-in key or a driver uuid, nothing else', () => {
    for (const ok of ['h42', 'h123456789012', '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      expect(isRatingDriverKey(ok), ok).toBe(true);
    }
    for (const bad of [
      null,
      undefined,
      '',
      'h',
      'h1234567890123',
      'x42',
      '42',
      '0f8fad5b-d9cb-469f-a165',
      'h42&kind=eq.alpha',
    ]) {
      expect(isRatingDriverKey(bad), String(bad)).toBe(false);
    }
  });
});

describe('getSeriesRatingHistory', () => {
  it('reads one driver’s steps in one kind from the masked view, oldest first', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([historyRow({})]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const steps = await getSeriesRatingHistory(env, 'alpha', 'h42');
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/rest/v1/series_rating_history_shown');
    expect(url.searchParams.get('kind')).toBe('eq.alpha');
    expect(url.searchParams.get('driver_key')).toBe('eq.h42');
    expect(url.searchParams.get('order')).toBe('race_started_at.asc,subsession_id.asc,race_number.asc');
    const select = url.searchParams.get('select')!.split(',');
    expect(select).toContain('rating_after');
    for (const secret of ['driver_id', 'name', 'starting_irating', 'rating_before'])
      expect(select).not.toContain(secret);
    expect(steps).toEqual([{ d: '2026-04-01', s: 'ATC18', t: 'Spa', r: 0, p: 3, f: 12, v: 1416 }]);
  });

  it('throws when the read fails, so the route can answer with an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(getSeriesRatingHistory(env, 'overall', 'h42')).rejects.toThrow(/500/);
  });
});

describe('resolveRatingKind', () => {
  it('matches the class values exactly and falls back to Overall (BR3.13)', () => {
    expect(resolveRatingKind('Gamma')).toBe('gamma');
    expect(resolveRatingKind('gamma')).toBe('overall');
    expect(resolveRatingKind(null)).toBe('overall');
    expect(resolveRatingKind('overall')).toBe('overall');
  });
});

describe('getSeriesRatings', () => {
  it('reads the masked view for one kind with the allow-listed columns', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([viewRow({ driver_key: 'a', current: 1401 })]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const rows = await getSeriesRatings(env, 'delta');
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/rest/v1/series_ratings_shown');
    expect(url.searchParams.get('kind')).toBe('eq.delta');
    expect(url.searchParams.get('select')).not.toContain('starting_irating');
    expect(url.searchParams.get('order')).toBe('current.desc,driver_key.asc');
    // The 5-race filter runs in the read too, so fewer rows leave the database.
    expect(url.searchParams.get('races')).toBe('gte.5');
    expect(rows.map((r) => r.current)).toEqual([1401]);
  });

  it('returns an empty list when the kind has no rated races yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    expect(await getSeriesRatings(env, 'gamma')).toEqual([]);
  });

  it('throws when the read fails, so the fragment can show its load error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(getSeriesRatings(env, 'overall')).rejects.toThrow(/500/);
  });
});
