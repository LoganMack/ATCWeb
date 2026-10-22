/**
 * Runs on every on-demand request: resolves the session from cookies (refreshing it), exposes it as
 * `Astro.locals.session`, and gates /admin to signed-in admins. Also an edge cache via the Workers Cache API,
 * since a Cache-Control header alone doesn't cache a Worker response.
 * Never return a `cache.match()` response directly: its headers are immutable and Astro deletes a header from
 * it, which made every cache hit a 500 in production. Rebuild it into a fresh `Response`.
 */

import { defineMiddleware } from 'astro:middleware';
import { resolveSupabaseEnv, restGet, type SupabaseEnv } from './lib/db/client';
import { logPageView } from './lib/db/analytics';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  VIEW_MODE_COOKIE,
  BROADCASTER_COOKIE,
  authCookieOptions,
  getUser,
  getProfile,
  refreshSession,
} from './lib/auth';
import { contentSecurityPolicy, newCspNonce } from './lib/csp';
import { cacheKeyUrl, isCacheAnonymous } from './lib/edgeCache';

const ADMIN_PREFIX = '/admin';

// A fixed, non-secret salt for the page-view visitor hash below — see
// 0077_page_views.sql's header for why a hardcoded value is an accepted
// tradeoff: it keeps the raw IP out of the database, which is the goal.
const PAGE_VIEW_SALT = 'atc-page-view-v1';

/**
 * sha256(ip + user-agent + salt + UTC calendar date), hex-truncated to 32
 * chars — see 0077_page_views.sql for the privacy reasoning (rotates daily on
 * purpose, never stores the raw IP).
 */
async function hashVisitor(ip: string, userAgent: string, dateStr: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}|${userAgent}|${PAGE_VIEW_SALT}|${dateStr}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Pages opt into the shared edge cache with `public, s-maxage, stale-while-revalidate`. Browsers would serve
 * their own stale copy (the Broadcaster toggle seemed broken until a refresh), so the browser copy gets
 * `max-age=0, must-revalidate`; explicit `max-age` responses are left alone.
 */
function forBrowser(response: Response): Response {
  const cc = response.headers.get('Cache-Control') ?? '';
  if (cc.includes('public') && !/(^|[\s,])max-age=/.test(cc)) {
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  return response;
}

/**
 * Canonical form of a request path for access-control decisions: fully
 * percent-decoded, backslashes treated as slashes, duplicate slashes
 * collapsed, trailing slash dropped, lowercased. Returns null when the path
 * has invalid encoding (callers should fail closed).
 */
function normalisePath(pathname: string): string | null {
  let p = pathname;
  try {
    for (let i = 0; i < 5; i++) {
      const decoded = decodeURIComponent(p);
      if (decoded === p) break;
      p = decoded;
    }
  } catch {
    return null;
  }
  p = p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Baseline security headers. The CSP (src/lib/csp.ts) is set per response in withSecurityHeaders because its
 * nonce must be fresh.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // microphone=(self): the results page's Record Interview button needs getUserMedia on this origin.
  'Permissions-Policy':
    'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

function withSecurityHeaders(response: Response): Response {
  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(newCspNonce()) };
  try {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  } catch {
    // Immutable headers (e.g. a passthrough of a fetched Response) — rebuild.
    const copy = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
  return response;
}

// Broadcaster mode hides the most recent round. Its id is memoised per isolate
// for up to 60 s, so broadcaster renders don't add a database call each.
const LATEST_ROUND_TTL_MS = 60_000;
let latestRoundMemo: { subsessionId: number | null; expiresAt: number } | null = null;

async function latestRoundSubsessionId(env: SupabaseEnv): Promise<number | null> {
  const now = Date.now();
  if (latestRoundMemo && latestRoundMemo.expiresAt > now) return latestRoundMemo.subsessionId;
  const latest = await restGet<{ subsession_id: number }[]>(
    env,
    'curated_rounds?select=subsession_id&order=start_time.desc&limit=1',
  );
  latestRoundMemo = { subsessionId: latest[0]?.subsession_id ?? null, expiresAt: now + LATEST_ROUND_TTL_MS };
  return latestRoundMemo.subsessionId;
}

/** GoTrue rejected the refresh token (4xx), as opposed to a network failure. */
function isRejectedRefresh(err: unknown): boolean {
  return err instanceof Error && /^Session refresh failed \(4\d\d\)/.test(err.message);
}

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.session = null;

  const env = resolveSupabaseEnv(context.locals);
  const accessToken = context.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = context.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const cookieOptions = authCookieOptions(context.url);
  // "View as Broadcaster" (src/lib/auth.ts BROADCASTER_COOKIE): anyone can turn
  // it on. Its render differs from the normal page, so it gets its own edge
  // cache entry and is never stored by the browser.
  const broadcasterMode = context.cookies.get(BROADCASTER_COOKIE)?.value === '1';
  context.locals.broadcasterMode = broadcasterMode;

  // Treated as a signed-out visitor for the shared cache unless the cookies
  // could hold a real session (see isCacheAnonymous). A malformed access
  // cookie with no refresh cookie can't, so it is dropped instead of costing
  // an auth call on every request.
  const cacheAnonymous = isCacheAnonymous(accessToken, refreshToken);
  if (cacheAnonymous && accessToken) context.cookies.delete(ACCESS_TOKEN_COOKIE, cookieOptions);

  // `locals.runtime` only exists on the Worker (deployed or `wrangler dev`),
  // not in `astro dev`, so the cache simply no-ops there.
  const cache = context.locals.runtime?.caches?.default;
  const cacheEligible = Boolean(cache) && context.request.method === 'GET' && cacheAnonymous;
  const cacheKey = cacheKeyUrl(context.url, broadcasterMode ? 'broadcaster' : 'default');

  // --- Edge cache read ------------------------------------------------------
  // Rebuilt into a fresh Response (mutable headers) — see the file header.
  if (cache && cacheEligible) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      // Cloudflare's ReadableStream and Headers types differ from the DOM ones Response expects; the objects are the same at runtime.
      const hit = new Response(cached.body as BodyInit | null, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers as unknown as HeadersInit,
      });
      hit.headers.set('X-ATC-Cache', 'HIT');
      if (broadcasterMode) hit.headers.set('Cache-Control', 'private, no-store');
      return withSecurityHeaders(forBrowser(hit));
    }
  }

  // Broadcaster mode: hand the most recent round's id to every downstream
  // resolveSupabaseEnv(locals) call, which makes restGet/restGetAll exclude it.
  // A failed lookup means nothing is hidden this request (logged), so that
  // unfiltered render must never be stored under the broadcaster cache key.
  if (broadcasterMode && env.url && env.anonKey) {
    try {
      const latest = await latestRoundSubsessionId(env);
      if (latest !== null) context.locals.broadcasterHiddenSubsessionIds = [latest];
    } catch (err) {
      context.locals.uncacheable = true;
      console.error('Broadcaster mode: failed to look up the latest round:', err);
    }
  }

  if (env.url && env.anonKey && !cacheAnonymous) {
    try {
      let activeAccessToken = accessToken;
      let user = activeAccessToken ? await getUser(env, activeAccessToken) : null;

      // Access token missing or expired — fall back to the refresh token
      // before treating the visitor as logged out.
      if (!user && refreshToken) {
        const refreshed = await refreshSession(env, refreshToken);
        activeAccessToken = refreshed.accessToken;
        user = refreshed.user;
        context.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, {
          ...cookieOptions,
          maxAge: 60 * 60, // access tokens are short-lived; this just bounds the cookie's own lifetime
        });
        context.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, {
          ...cookieOptions,
          maxAge: 60 * 60 * 24 * 30,
        });
      } else if (!user && accessToken) {
        // A dead access token with nothing to refresh it: drop it so the
        // browser goes back to cached pages.
        context.cookies.delete(ACCESS_TOKEN_COOKIE, cookieOptions);
      }

      if (user && activeAccessToken) {
        const profile = await getProfile(env, activeAccessToken, user.id);
        context.locals.session = { user, profile, accessToken: activeAccessToken };
      }
    } catch (err) {
      // Treat the request as logged out; never fail it. A refresh token the
      // auth server rejected is cleared with its access token, so the browser
      // returns to cached pages. A network failure keeps them for next time.
      console.error('Auth middleware error:', err);
      if (isRejectedRefresh(err)) {
        context.cookies.delete(ACCESS_TOKEN_COOKIE, cookieOptions);
        context.cookies.delete(REFRESH_TOKEN_COOKIE, cookieOptions);
      }
    }
  }

  // "View as Visitor" (see src/lib/auth.ts's isAdminView): computed on every
  // request since the footer toggle renders on every page. Independent of the
  // /admin gate below, which stays keyed on the REAL role.
  context.locals.isRealAdmin = context.locals.session?.profile?.role === 'admin';
  context.locals.viewAsVisitor =
    context.locals.isRealAdmin && context.cookies.get(VIEW_MODE_COOKIE)?.value === 'visitor';

  const pathname = context.url.pathname;
  // SECURITY: gate on a NORMALISED path (Astro's router percent-decodes, so
  // /%61dmin would otherwise slip past a plain prefix check). Undecodable
  // paths count as admin paths (fail closed).
  const normalisedPath = normalisePath(pathname);
  const isAdminRoute = normalisedPath === null || normalisedPath.startsWith(ADMIN_PREFIX);

  let response: Response;
  if (isAdminRoute) {
    const session = context.locals.session;
    if (!session || session.profile?.role !== 'admin') {
      response = context.redirect(`/login?next=${encodeURIComponent(pathname)}`, 302);
    } else {
      response = await next();
    }
  } else {
    response = await next();
  }

  // A render that hit a data-load failure (markUncacheable) is never stored
  // anywhere, whatever Cache-Control the page set afterwards.
  if (context.locals.uncacheable) response.headers.set('Cache-Control', 'no-store');

  // --- Edge cache write: cache-eligible, no session, 200, no Set-Cookie, not marked uncacheable, and
  // `public`. The broadcaster render has its own key; the write runs in `waitUntil` on a clone.
  if (cacheEligible) {
    const storable =
      !context.locals.session &&
      !context.locals.uncacheable &&
      response.status === 200 &&
      !response.headers.has('Set-Cookie') &&
      (response.headers.get('Cache-Control') ?? '').includes('public');
    if (storable) {
      // cache.put is typed with Cloudflare's Response, not the DOM one Astro returns; the object is the same at runtime.
      context.locals.runtime.ctx.waitUntil(
        cache!.put(cacheKey, response.clone() as unknown as Parameters<NonNullable<typeof cache>['put']>[1]),
      );
      response.headers.set('X-ATC-Cache', 'MISS');
    }
  }

  // Never let a browser or intermediary hold a broadcaster render (set after
  // the edge copy above captured the page's own header).
  if (broadcasterMode) response.headers.set('Cache-Control', 'private, no-store');

  forBrowser(response);
  response = withSecurityHeaders(response);

  // --- Site analytics (page_views via record_page_view, 0114): one row per real public page hit (GET; not
  // /admin, /api, fragments or admins; 200s and errors only). Worker only, never from localhost, so dev runs
  // don't write to production.
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(context.url.hostname);
  if (
    context.locals.runtime &&
    !isLocalHost &&
    context.request.method === 'GET' &&
    !isAdminRoute &&
    !pathname.startsWith('/api') &&
    !pathname.endsWith('/fragment') &&
    !context.locals.isRealAdmin &&
    (response.status === 200 || response.status >= 400)
  ) {
    context.locals.runtime.ctx.waitUntil(
      (async () => {
        try {
          const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
          const userAgent = context.request.headers.get('User-Agent') ?? '';
          const today = new Date().toISOString().slice(0, 10);
          const visitorHash = await hashVisitor(ip, userAgent, today);
          const country = (context.locals.runtime?.cf as { country?: string } | undefined)?.country ?? null;
          await logPageView(env, { path: pathname, country, visitorHash, status: response.status });
        } catch (err) {
          console.error('Page view logging failed:', err);
        }
      })(),
    );
  }

  return response;
});
