/**
 * Edge-cache key rules for src/middleware.ts. The key keeps only the query parameters a route reads, so
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
  [/^\/media(\/fragment)?$/, ['filter', 'layout', 'tab']],
  [/^\/news(\/fragment)?$/, ['q', 'season']],
  [/^\/results(\/fragment)?$/, ['season']],
  [/^\/results\/[^/]+(\/fragment)?$/, ['category', 'class', 'links_error', 'report', 'season', 'session']],
  [/^\/results\/[^/]+\/incidents(\/fragment)?$/, ['appeal', 'review', 'roundpenalty', 'season', 'view']],
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
 * The edge-cache key for a request: origin + path + the route's known
 * parameters (first value each, sorted), plus `__variant=broadcaster` for the
 * broadcaster render so the two never share an entry.
 */
export function cacheKeyUrl(url: URL, variant: 'default' | 'broadcaster' = 'default'): string {
  const key = new URL(url.origin + url.pathname);
  for (const name of [...cacheQueryParams(url.pathname)].sort()) {
    const value = url.searchParams.get(name);
    if (value !== null) key.searchParams.set(name, value);
  }
  if (variant === 'broadcaster') key.searchParams.set('__variant', 'broadcaster');
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
