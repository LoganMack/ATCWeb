/**
 * The track-record inputs (src/lib/db/roundBestLaps.ts, getLayoutImages in src/lib/db/circuits.ts; NFR2, NFR3,
 * BR6.3): the request each one sends, the broadcaster filter, the per-request memo and the empty fallback when a
 * read fails. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRoundBestLaps } from '../../src/lib/db/roundBestLaps';
import { getLayoutImages } from '../../src/lib/db/circuits';
import { RequestMemo } from '../../src/lib/requestMemo';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };
const LAYOUT_A = '11111111-2222-4333-8444-555555555555';
const LAYOUT_B = '22222222-3333-4444-8555-666666666666';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urlOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
  new URL((fetchMock.mock.calls[i] as [string])[0]);

const row = {
  subsession_id: 1,
  class_id: 2,
  best_lap_ten_thousandths: 905_123,
  race_number: 1,
  finish_position: 3,
  cust_id: 77,
  roster_driver_id: 'd1',
  display_name: 'Driver One',
  car_name: 'Car',
  track_name: 'Spa',
  layout: 'Grand Prix',
  start_time: '2026-10-01T18:00:00+00:00',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getRoundBestLaps', () => {
  it('reads the masked view with every column, in subsession and class order', async () => {
    const fetchMock = stubFetch(respond([row]));
    expect(await getRoundBestLaps(env)).toEqual([row]);
    const url = urlOf(fetchMock, 0);
    expect(url.pathname).toBe('/rest/v1/round_best_laps_shown');
    expect(url.searchParams.get('select')).toBe(
      'subsession_id,class_id,best_lap_ten_thousandths,race_number,finish_position,cust_id,roster_driver_id,' +
        'display_name,car_name,track_name,layout,start_time',
    );
    expect(url.searchParams.get('order')).toBe('subsession_id.asc,class_id.asc');
    expect(url.searchParams.has('start_time')).toBe(false);
  });

  it('limits the rows to rounds that started by the cutoff (BR1.8)', async () => {
    const fetchMock = stubFetch(respond([]));
    await getRoundBestLaps(env, { maxStartTime: '2026-10-01T18:00:00+00:00' });
    expect(urlOf(fetchMock, 0).searchParams.get('start_time')).toBe('lte.2026-10-01T18:00:00+00:00');
  });

  it("leaves out the broadcaster's hidden rounds", async () => {
    const fetchMock = stubFetch(respond([]));
    await getRoundBestLaps({ ...env, hiddenSubsessionIds: [5, 6] });
    expect(urlOf(fetchMock, 0).searchParams.get('subsession_id')).toBe('not.in.(5,6)');
  });

  it('reads once per request for the same cutoff', async () => {
    const fetchMock = stubFetch(respond([row]), respond([]));
    const memoEnv = { ...env, memo: new RequestMemo(false) };
    await getRoundBestLaps(memoEnv);
    await getRoundBestLaps(memoEnv);
    await getRoundBestLaps(memoEnv, { maxStartTime: '2026-10-01T18:00:00+00:00' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs a failed read and returns no rows, so pages fall back to typed records', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(respond('down', 503));
    expect(await getRoundBestLaps(env)).toEqual([]);
    expect(log).toHaveBeenCalled();
  });
});

describe('getLayoutImages', () => {
  it('reads each valid layout once from the shown view', async () => {
    const fetchMock = stubFetch(
      respond([
        { id: LAYOUT_A, image_url: 'https://img/a.png' },
        { id: LAYOUT_B, image_url: null },
      ]),
    );
    const images = await getLayoutImages(env, [LAYOUT_A, LAYOUT_B, LAYOUT_A, 'not-a-uuid)']);
    const url = urlOf(fetchMock, 0);
    expect(url.pathname).toBe('/rest/v1/circuit_layouts_shown');
    expect(url.searchParams.get('select')).toBe('id,image_url');
    expect(url.searchParams.get('id')).toBe(`in.(${LAYOUT_A},${LAYOUT_B})`);
    expect(images.get(LAYOUT_A)).toBe('https://img/a.png');
    expect(images.get(LAYOUT_B)).toBeNull();
  });

  it('sends no request when there is nothing to look up', async () => {
    const fetchMock = stubFetch();
    expect((await getLayoutImages(env, ['x'])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs a failed read and returns no images', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(respond('down', 500));
    expect((await getLayoutImages(env, [LAYOUT_A])).size).toBe(0);
    expect(log).toHaveBeenCalled();
  });
});
