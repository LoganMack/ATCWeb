/**
 * BR4.1: the per-request memo. A repeated read in one request reuses the first, a rejected read is
 * dropped so it can be retried, two requests never share an entry, and a memoised result is frozen in
 * tests so a caller that mutates it fails loudly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestMemo, deepFreeze, memoized } from '../../src/lib/requestMemo';
import { getSeasons } from '../../src/lib/db/seasons';
import { getStandingsExcludedRoundIds } from '../../src/lib/db/rounds';
import type { SupabaseEnv } from '../../src/lib/db/client';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

/** A fetch stub answering every GET with `body`, counting the calls. */
function stubFetch(body: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const envWith = (memo?: RequestMemo): SupabaseEnv => ({
  url: 'https://example.invalid',
  anonKey: 'anon',
  memo,
});

describe('RequestMemo', () => {
  it('reuses the first call for a repeated read in the same request', async () => {
    const memo = new RequestMemo();
    const load = vi.fn(async () => [1, 2, 3]);
    const [a, b] = await Promise.all([memo.run('f', [1], load), memo.run('f', [1], load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    // Different arguments are a different entry.
    await memo.run('f', [2], load);
    expect(load).toHaveBeenCalledTimes(2);

    // Through a reference loader: two getSeasons calls on one request's env make one request.
    const calls = stubFetch([{ id: 's1', number: 17, name: 'ATC17' }]);
    const env = envWith(new RequestMemo());
    const [first, second] = await Promise.all([getSeasons(env), getSeasons(env)]);
    expect(calls).toHaveLength(1);
    expect(first).toBe(second);
  });

  it('drops a rejected entry, so a retry in the same request runs again', async () => {
    const memo = new RequestMemo();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('ok');
    await expect(memo.run('g', [], load)).rejects.toThrow('timeout');
    expect(memo.size).toBe(0);
    await expect(memo.run('g', [], load)).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
    expect(memo.size).toBe(1);
  });

  it('never shares entries between requests', async () => {
    const load = vi.fn(async () => ({ value: 1 }));
    const a = await memoized(envWith(new RequestMemo()), 'h', [], load);
    const b = await memoized(envWith(new RequestMemo()), 'h', [], load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
    // No memo at all (scripts, prerender): straight through every time.
    await memoized(envWith(), 'h', [], load);
    await memoized(envWith(), 'h', [], load);
    expect(load).toHaveBeenCalledTimes(4);

    const calls = stubFetch([{ subsession_id: 1 }]);
    await getStandingsExcludedRoundIds(envWith(new RequestMemo()));
    await getStandingsExcludedRoundIds(envWith(new RequestMemo()));
    // Two requests, each reading the exhibition and the test flags once.
    expect(calls).toHaveLength(4);
  });

  it('freezes a memoised result, so mutating it throws', async () => {
    const memo = new RequestMemo(true);
    const rows = await memo.run('rows', [], async () => [{ id: 'a', tags: ['x'] }]);
    expect(() => (rows as { id: string }[]).push({ id: 'b' } as never)).toThrow(TypeError);
    expect(() => {
      (rows[0] as { id: string }).id = 'changed';
    }).toThrow(TypeError);
    const ids = await memo.run('ids', [], async () => new Set([1, 2]));
    expect(() => ids.add(3)).toThrow(/memoised result/);
    const byId = deepFreeze(new Map([['a', [1]]]));
    expect(() => byId.set('b', [2])).toThrow(TypeError);
    expect(() => byId.get('a')!.push(3)).toThrow(TypeError);
    // Without freezing (production) the result is handed back as it was loaded.
    const loose = await new RequestMemo(false).run('rows', [], async () => [1]);
    loose.push(2);
    expect(loose).toEqual([1, 2]);
  });
});
