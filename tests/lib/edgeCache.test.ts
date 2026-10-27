/**
 * Serve-stale-while-refreshing rules in src/lib/edgeCache.ts: the windows a page declares, the stored-copy
 * format and the per-instance refresh guard (BR2.1-BR2.4, BR2.6, BR3.1).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_STALE_SECONDS,
  PAGE_CACHE_CONTROL_HEADER,
  STORED_AT_HEADER,
  cacheKeyUrl,
  cacheWindows,
  createRefreshGuard,
  readStoredCopy,
  toStoredCopy,
} from '../../src/lib/edgeCache';

const PAGE_CC = 'public, s-maxage=60, stale-while-revalidate=300';
const STORED_AT = 1_800_000_000_000;

function page(cacheControl: string, body = '<p>standings</p>'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Cache-Control': cacheControl, 'Content-Type': 'text/html' },
  });
}

/** A copy as the edge cache hands it back, stored at STORED_AT. */
function storedPage(cacheControl = PAGE_CC): Response {
  return toStoredCopy(page(cacheControl), STORED_AT);
}

describe('cacheWindows', () => {
  it('reads the fresh and stale windows a page declares', () => {
    expect(cacheWindows(PAGE_CC)).toEqual({ freshSeconds: 60, staleSeconds: 300 });
  });

  it('gives a stale window of 0 when the page declares only s-maxage', () => {
    expect(cacheWindows('public, s-maxage=120')).toEqual({ freshSeconds: 120, staleSeconds: 0 });
  });

  it('caps a long stale window at an hour', () => {
    expect(cacheWindows('public, s-maxage=86400, stale-while-revalidate=604800')).toEqual({
      freshSeconds: 86400,
      staleSeconds: MAX_STALE_SECONDS,
    });
    expect(MAX_STALE_SECONDS).toBe(3600);
  });

  it('is null when there is no s-maxage, so the page sets no edge lifetime', () => {
    expect(cacheWindows('public, max-age=3600')).toBeNull();
    expect(cacheWindows('no-store')).toBeNull();
    expect(cacheWindows(null)).toBeNull();
  });
});

describe('toStoredCopy', () => {
  it('keeps the copy for fresh plus stale time and records when and what the page declared', async () => {
    const original = page(PAGE_CC, '<p>body</p>');
    const copy = toStoredCopy(original, STORED_AT);

    expect(copy.headers.get('Cache-Control')).toBe('public, s-maxage=360');
    expect(copy.headers.get(STORED_AT_HEADER)).toBe(String(STORED_AT));
    expect(copy.headers.get(PAGE_CACHE_CONTROL_HEADER)).toBe(PAGE_CC);
    // A clone: the response sent to the visitor keeps its own header and body.
    expect(original.headers.get('Cache-Control')).toBe(PAGE_CC);
    expect(await copy.text()).toBe('<p>body</p>');
    expect(await original.text()).toBe('<p>body</p>');
  });
});

describe('readStoredCopy', () => {
  it('is fresh at 59 s', () => {
    expect(readStoredCopy(storedPage(), STORED_AT + 59_000).state).toBe('fresh');
  });

  it('is stale at 61 s', () => {
    expect(readStoredCopy(storedPage(), STORED_AT + 61_000).state).toBe('stale');
  });

  it('is expired at 361 s, past fresh plus stale time', () => {
    expect(readStoredCopy(storedPage(), STORED_AT + 361_000).state).toBe('expired');
  });

  it('counts a copy stored before this format (no stored-at) as fresh', () => {
    const legacy = page(PAGE_CC);
    const { state, response } = readStoredCopy(legacy, STORED_AT + 10 * 60_000);
    expect(state).toBe('fresh');
    expect(response.headers.get('Cache-Control')).toBe(PAGE_CC);
  });

  it('restores the declared Cache-Control and removes the internal headers', async () => {
    const { response } = readStoredCopy(storedPage(), STORED_AT + 61_000);
    expect(response.headers.get('Cache-Control')).toBe(PAGE_CC);
    expect(response.headers.has(STORED_AT_HEADER)).toBe(false);
    expect(response.headers.has(PAGE_CACHE_CONTROL_HEADER)).toBe(false);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<p>standings</p>');
  });
});

describe('cacheKeyUrl', () => {
  it('has one key per page, with no broadcaster variant (only signed-out renders are stored)', () => {
    const key = cacheKeyUrl(new URL('https://x.test/standings?season=atc-17&__variant=broadcaster'));
    expect(key).toBe('https://x.test/standings?season=atc-17');
    expect(cacheKeyUrl.length).toBe(1);
  });
});

describe('createRefreshGuard', () => {
  function clock(start = 0) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('refuses a second refresh of the same key within 30 s', () => {
    const c = clock();
    const guard = createRefreshGuard(c.now);
    expect(guard.tryStart('k')).toBe(true);
    c.advance(29_000);
    expect(guard.tryStart('k')).toBe(false);
  });

  it('allows a refresh again once the first one finishes', () => {
    const guard = createRefreshGuard(clock().now);
    expect(guard.tryStart('k')).toBe(true);
    guard.finish('k');
    expect(guard.tryStart('k')).toBe(true);
  });

  it('allows a refresh after 30 s even if the first one never finished', () => {
    const c = clock();
    const guard = createRefreshGuard(c.now);
    expect(guard.tryStart('k')).toBe(true);
    c.advance(30_000);
    expect(guard.tryStart('k')).toBe(true);
  });

  it('keeps keys independent', () => {
    const guard = createRefreshGuard(clock().now);
    expect(guard.tryStart('https://x.test/standings')).toBe(true);
    expect(guard.tryStart('https://x.test/standings?season=atc-17')).toBe(true);
    expect(guard.tryStart('https://x.test/standings')).toBe(false);
  });
});
