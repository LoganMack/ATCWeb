/**
 * The Series iRating read (src/lib/db/seriesRatings.ts; FR7, NFR2, NFR4, BR3.13): the request it sends to the
 * masked view, the order and trend cap it applies, that a hidden driver's row never carries an id, and the
 * class value fallback. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSeriesRatings,
  resolveRatingKind,
  shapeSeriesRatings,
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
    races: 1,
    trend: [1350],
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('shapeSeriesRatings', () => {
  it('orders by current rating, then races, then name', () => {
    const rows = shapeSeriesRatings([
      viewRow({ driver_key: 'a', name: 'Bea', current: 1400, races: 3 }),
      viewRow({ driver_key: 'b', name: 'Al', current: 1400, races: 3 }),
      viewRow({ driver_key: 'c', name: 'Cy', current: 1500, races: 1 }),
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([viewRow({ driver_key: 'a', current: 1401 })]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const rows = await getSeriesRatings(env, 'delta');
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/rest/v1/series_ratings_shown');
    expect(url.searchParams.get('kind')).toBe('eq.delta');
    expect(url.searchParams.get('select')).not.toContain('starting_irating');
    expect(url.searchParams.get('order')).toBe('current.desc,driver_key.asc');
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
