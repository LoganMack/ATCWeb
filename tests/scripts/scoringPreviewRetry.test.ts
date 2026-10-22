import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPreview, isStatementTimeout } from '../../scripts/lib/scoringComparison';
import { switchesWithOnly } from '../../scripts/lib/scoringAttribution';

const env = { url: 'https://example.invalid', anonKey: 'test-key' };
const TIMEOUT_BODY = '{"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}';

function respond(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStatementTimeout', () => {
  it('recognises the 57014 statement timeout', () => {
    expect(isStatementTimeout(500, TIMEOUT_BODY)).toBe(true);
  });

  it('does not treat other failures as a timeout', () => {
    expect(isStatementTimeout(400, '{"code":"P0001","message":"Unknown or non-boolean scoring switch: x"}')).toBe(false);
    expect(isStatementTimeout(500, '{"code":"42883","message":"function does not exist"}')).toBe(false);
  });
});

describe('fetchPreview', () => {
  it('retries a statement timeout and returns the rows of the next attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(500, TIMEOUT_BODY))
      .mockResolvedValueOnce(respond(200, '[{"subsession_id":1001}]'));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchPreview(env, 1001, switchesWithOnly([]), 3, () => 0);

    expect(rows).toEqual([{ subsession_id: 1001 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last retry and names the round', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => respond(500, TIMEOUT_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPreview(env, 1001, switchesWithOnly([]), 2, () => 0)).rejects.toThrow(
      'score_round_preview(1001) failed with 500',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that is not a timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(400, '{"code":"P0001","message":"Unknown switch"}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPreview(env, 1001, switchesWithOnly([]), 3, () => 0)).rejects.toThrow('failed with 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends every switch, including unclassified-position', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, '[]'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPreview(env, 1001, switchesWithOnly(['unclassified-position']), 0);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.p_switches['unclassified-position']).toBe(true);
    expect(body.p_switches['cross-class-ripple']).toBe(false);
  });
});
