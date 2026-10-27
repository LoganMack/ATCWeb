/**
 * Edge-cache rules for src/middleware.ts: the cache key, the stored-copy format that lets a copy be served
 * stale while it refreshes, and the refresh guard. The key keeps only the query parameters a route reads, so
 * `?x=<random>` can't force an uncached render; shells list their fragment's parameters too. Add a route's
 * new parameters here, or it is cached under its bare path.
 */

const ROUTE_QUERY_PARAMS: [RegExp, string[]][] = [
  [/^\/calendar(\/fragment)?$/, ['season']],
  [/^\/champions(\/fragment)?$/, ['class', 'team']],
  [/^\/champions\/season-results\/[^/]+\/[^/]+$/, ['class']],
  [/^\/driver-stats(\/fragment)?$/, ['class']],
  [/^\/drivers\/[^/]+$/, ['profile_error', 'saved']],
  [/^\/drivers\/[^/]+\/fragment$/, ['hof']],
  [/^\/drivers\/[^/]+\/awards$/, []],
  [/^\/drivers\/[^/]+\/kudos$/, []],
  [/^\/interviews(\/fragment)?$/, ['season']],
  [/^\/kudos(\/fragment)?$/, ['season']],
  [/^\/media(\/fragment)?$/, ['filter', 'layout', 'tab']],
  [/^\/news(\/fragment)?$/, ['q', 'season']],
  [/^\/results(\/fragment)?$/, ['season']],
  [/^\/results\/[^/]+(\/fragment)?$/, ['category', 'class', 'links_error', 'report', 'season', 'session']],
  [
    /^\/results\/[^/]+\/incidents(\/fragment)?$/,
    ['appeal', 'review', 'roundpenalty', 'season', 'submission', 'view'],
  ],
  [/^\/results\/[^/]+\/kudos(\/fragment)?$/, ['kudos', 'season']],
  [/^\/standings(\/fragment)?$/, ['championship', 'class', 'mode', 'round', 'season', 'view']],
  [/^\/team-stats(\/fragment)?$/, ['view']],
  [/^\/teams(\/fragment)?$/, ['season']],
  [/^\/api\/layout-rounds$/, ['circuitId', 'layout']],
  [/^\/api\/photo-album-thumbnail$/, ['url']],
  [/^\/api\/import-templates\/[^/]+$/, ['eventId']],
];

/** Query parameters that are part of the cache key for this path. */
export function cacheQueryParams(pathname: string): string[] {
  for (const [pattern, params] of ROUTE_QUERY_PARAMS) {
    if (pattern.test(pathname)) return params;
  }
  return [];
}

/**
 * The edge-cache key for a request: origin + path + the route's known parameters (first value each, sorted).
 * Only signed-out renders are stored, so the Broadcaster's spoiler-free render never needs a key of its own.
 */
export function cacheKeyUrl(url: URL): string {
  const key = new URL(url.origin + url.pathname);
  for (const name of [...cacheQueryParams(url.pathname)].sort()) {
    const value = url.searchParams.get(name);
    if (value !== null) key.searchParams.set(name, value);
  }
  return key.toString();
}

/** Three base64url segments. Anything else can't be a Supabase access token, so it isn't worth an auth call. */
export function isJwtShaped(token: string | undefined): boolean {
  return (
    typeof token === 'string' &&
    token.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  );
}

/**
 * Cookie rule for the shared cache: a request is anonymous (cache-eligible)
 * when it has no refresh cookie and its access cookie is missing or not
 * JWT-shaped. Any refresh cookie takes the uncached path so the session can refresh.
 */
export function isCacheAnonymous(accessToken: string | undefined, refreshToken: string | undefined): boolean {
  return !refreshToken && !isJwtShaped(accessToken);
}

// --- Serve stale while refreshing --------------------------------------------------------------------------
// The Cache API drops a copy at its own s-maxage, so a copy stored with the page's s-maxage could never be
// served stale. The stored copy therefore lives for fresh + stale time and carries the page's declared header
// and the time it was stored; readStoredCopy works out its state from those and puts the declared header back.

/** When the copy was stored, in epoch milliseconds. */
export const STORED_AT_HEADER = 'X-ATC-Stored-At';
/** The page's own Cache-Control, which the stored copy's longer lifetime replaces. */
export const PAGE_CACHE_CONTROL_HEADER = 'X-ATC-Page-Cache-Control';
/** A long declared stale window (the photo thumbnail's 7 days) is cut to this, so no copy is served hours old. */
export const MAX_STALE_SECONDS = 3600;

export type CacheWindows = { freshSeconds: number; staleSeconds: number };
export type StoredCopyState = 'fresh' | 'stale' | 'expired';

function directiveSeconds(cacheControl: string, name: string): number | null {
  const match = new RegExp(`(?:^|[\\s,])${name}=(\\d+)`, 'i').exec(cacheControl);
  return match ? Number(match[1]) : null;
}

/**
 * The fresh and stale windows a page declares (`s-maxage`, `stale-while-revalidate`). No stale window means 0,
 * which behaves exactly as before; no `s-maxage` means the page sets no edge lifetime, so null.
 */
export function cacheWindows(cacheControl: string | null | undefined): CacheWindows | null {
  const freshSeconds = directiveSeconds(cacheControl ?? '', 's-maxage');
  if (freshSeconds === null) return null;
  const staleSeconds = Math.min(
    directiveSeconds(cacheControl ?? '', 'stale-while-revalidate') ?? 0,
    MAX_STALE_SECONDS,
  );
  return { freshSeconds, staleSeconds };
}

/**
 * The copy to put in the edge cache: kept for fresh + stale time, with the store time and the page's declared
 * header. A page without `s-maxage` is stored as it is, as before.
 */
export function toStoredCopy(response: Response, nowMs: number): Response {
  const copy = response.clone();
  const declared = copy.headers.get('Cache-Control') ?? '';
  const windows = cacheWindows(declared);
  if (!windows) return copy;
  copy.headers.set('Cache-Control', `public, s-maxage=${windows.freshSeconds + windows.staleSeconds}`);
  copy.headers.set(STORED_AT_HEADER, String(nowMs));
  copy.headers.set(PAGE_CACHE_CONTROL_HEADER, declared);
  return copy;
}

function copyState(storedAtMs: number, windows: CacheWindows | null, nowMs: number): StoredCopyState {
  if (!windows) return 'fresh';
  const ageSeconds = (nowMs - storedAtMs) / 1000;
  if (ageSeconds <= windows.freshSeconds) return 'fresh';
  return ageSeconds <= windows.freshSeconds + windows.staleSeconds ? 'stale' : 'expired';
}

/**
 * Reads a copy from the edge cache: its state and a new Response with the page's declared Cache-Control and
 * no internal headers. A new Response because `cache.match` headers are immutable (see src/middleware.ts). A
 * copy with no store time was stored before this format and counts as fresh until the cache drops it.
 */
export function readStoredCopy(
  cached: Response,
  nowMs: number,
): { state: StoredCopyState; response: Response } {
  const response = new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
  const storedAtMs = Number(response.headers.get(STORED_AT_HEADER));
  const declared = response.headers.get(PAGE_CACHE_CONTROL_HEADER);
  response.headers.delete(STORED_AT_HEADER);
  response.headers.delete(PAGE_CACHE_CONTROL_HEADER);
  if (!Number.isFinite(storedAtMs) || storedAtMs <= 0 || declared === null) {
    return { state: 'fresh', response };
  }
  response.headers.set('Cache-Control', declared);
  return { state: copyState(storedAtMs, cacheWindows(declared), nowMs), response };
}

/** How long a refresh marker lasts, so a hung refresh cannot block its key for good. */
export const REFRESH_MARKER_TTL_SECONDS = 30;

/**
 * The edge-cache key of the per-data-centre "refresh running" marker for a page key. cacheKeyUrl never keeps
 * an unknown parameter, so no visitor request can map to (or forge) this key.
 */
export function refreshMarkerKey(cacheKey: string): string {
  const url = new URL(cacheKey);
  url.searchParams.set('__refreshing', '1');
  return url.toString();
}

export type RefreshGuard = { tryStart(key: string): boolean; finish(key: string): void };

/**
 * One background refresh per key at a time in this Worker instance. The guarantee is per instance only; the
 * middleware adds a best-effort marker in the edge cache (refreshMarkerKey), so usually one per data centre.
 * Markers expire after REFRESH_MARKER_TTL_SECONDS even if `finish` is never called.
 */
export function createRefreshGuard(now: () => number = Date.now): RefreshGuard {
  const ttlMs = REFRESH_MARKER_TTL_SECONDS * 1000;
  const expiresAt = new Map<string, number>();
  return {
    tryStart(key) {
      const nowMs = now();
      const until = expiresAt.get(key);
      if (until !== undefined && until > nowMs) return false;
      // Drop expired markers so a long-lived instance doesn't accumulate them.
      for (const [k, t] of expiresAt) if (t <= nowMs) expiresAt.delete(k);
      expiresAt.set(key, nowMs + ttlMs);
      return true;
    },
    finish(key) {
      expiresAt.delete(key);
    },
  };
}
