/**
 * Runs on every on-demand-rendered request (i.e. every `prerender = false`
 * page — prerendered/static pages never hit this at request time, same as
 * they never see Astro.locals.runtime.env). Resolves the current session
 * from cookies (refreshing it if the access token expired) and gates
 * everything under /admin behind "logged in AND role === 'admin'".
 *
 * Session state is exposed as `Astro.locals.session` for every page/API
 * route, so nothing downstream needs to touch cookies directly.
 *
 * Also wraps everything above in a Cloudflare Workers Cache API
 * read-through/write-through layer (see the two blocks below marked "Edge
 * cache") — the site's on-demand pages already each set their own
 * Cache-Control: public, s-maxage=... header, but that header alone does
 * NOT get Cloudflare to actually cache a Worker-generated response; only
 * explicit use of the Cache API does. Without this, every visit to every
 * dynamic page was hitting Supabase fresh, for every visitor, regardless of
 * that header. See
 * https://developers.cloudflare.com/workers/reference/how-the-cache-works/
 *
 * CONFIRMED PITFALL (production incident, same day this was first added):
 * a `Response` returned by `cache.match()` has an IMMUTABLE `headers`
 * object. Astro's own `RenderContext.render()` (astro/dist/core/
 * render-context.js) sets an internal `astro-route-type` header on every
 * response during normal rendering, then unconditionally deletes it again
 * right after the middleware chain returns — see its own render() method:
 * `if (response.headers.get(ROUTE_TYPE_HEADER)) response.headers.delete(...)`.
 * The first version of this cache-read block returned the cached Response
 * object straight from `cache.match()` — which still carried that header,
 * baked in from when it was cached — and Astro's `.delete()` call on it
 * threw `TypeError: Can't modify immutable headers`, turning into a real
 * HTTP 500 (empty body) on every second-or-later request to a given URL.
 * Confirmed via an actual Cloudflare Worker exception log naming
 * `RenderContext.render` as the throw site. The fix: NEVER return a
 * `cache.match()` result directly — always rebuild it into a fresh
 * `Response` (mutable headers) first, exactly as done below.
 */

import { defineMiddleware } from 'astro:middleware';
import { resolveSupabaseEnv, logPageView } from './lib/supabase';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  VIEW_MODE_COOKIE,
  authCookieOptions,
  getUser,
  getProfile,
  refreshSession,
} from './lib/auth';

const ADMIN_PREFIX = '/admin';
// Paths under /admin that must stay reachable without a session.
// /admin/login is just a redirect stub to /login now (see that file) for
// old bookmarks, but it's still nominally "under /admin" by URL, so without
// this exemption the gate below would redirect an unauthenticated visitor
// away from it before it ever got the chance to redirect them itself.
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login']);

// A fixed, non-secret salt for the page-view visitor hash below — see
// 0077_page_views.sql's own header comment for exactly why a hardcoded
// value (rather than a real per-deploy secret, which this project has no
// mechanism for) is an accepted tradeoff here: it keeps the raw IP out of
// the database, which is the actual goal, not resisting a determined
// attacker who already has source access.
const PAGE_VIEW_SALT = 'atc-page-view-v1';

/**
 * sha256(ip + user-agent + salt + UTC calendar date), hex-truncated to 32
 * chars — see 0077_page_views.sql for the full privacy reasoning (rotates
 * daily on purpose, never stores the raw IP). `crypto.subtle` is a Web
 * Crypto API global available both on the deployed Cloudflare Worker and in
 * modern Node (local `astro dev`) — no extra dependency needed.
 */
async function hashVisitor(ip: string, userAgent: string, dateStr: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}|${userAgent}|${PAGE_VIEW_SALT}|${dateStr}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.session = null;

  const env = resolveSupabaseEnv(context.locals);
  const accessToken = context.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = context.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  const hasAuthCookies = Boolean(accessToken || refreshToken);

  // `context.locals.runtime` only exists on the deployed Cloudflare Worker
  // (see @astrojs/cloudflare's server.js, which is what actually populates
  // it) — it's undefined in local `astro dev`, so this whole feature is
  // optional-chained throughout and simply no-ops locally instead of
  // erroring. `caches.default` (not a bare global `caches`) is this
  // adapter's exact v11 API shape — see the resolveSupabaseEnv-style
  // `locals.runtime.env` access just above for the same pattern.
  const cache = context.locals.runtime?.caches?.default;
  const isCacheableMethod = context.request.method === 'GET';

  // --- Edge cache read (GET, anonymous requests only) ---------------------
  //
  // Skipped entirely whenever the request carries either auth cookie, even
  // before we know if they resolve to a real session below — a signed-in
  // (or session-expired-but-cookie-still-present) visitor always gets a
  // fully resolved render rather than risking a stale anonymous-rendered
  // page from the shared cache. Some nominally-public pages (e.g.
  // results/[subsessionId].astro) render admin-only UI when the viewer is a
  // signed-in admin, and this is the simplest way to guarantee that never
  // gets short-circuited by a cache hit meant for anonymous visitors.
  //
  // The cache hit is rebuilt into a fresh Response (mutable headers)
  // before returning — see this file's own top-of-file doc comment for
  // exactly why returning `cached` here directly crashes every such
  // request with a real 500.
  if (cache && isCacheableMethod && !hasAuthCookies) {
    const cached = await cache.match(context.request);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers,
      });
    }
  }

  if (env.url && env.anonKey && (accessToken || refreshToken)) {
    try {
      let activeAccessToken = accessToken;
      let user = activeAccessToken ? await getUser(env, activeAccessToken) : null;

      // Access token missing or expired — fall back to the refresh token
      // before treating the visitor as logged out.
      if (!user && refreshToken) {
        const refreshed = await refreshSession(env, refreshToken);
        activeAccessToken = refreshed.accessToken;
        user = refreshed.user;
        const cookieOptions = authCookieOptions(context.url);
        context.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, {
          ...cookieOptions,
          maxAge: 60 * 60, // access tokens are short-lived; this just bounds the cookie's own lifetime
        });
        context.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, {
          ...cookieOptions,
          maxAge: 60 * 60 * 24 * 30,
        });
      }

      if (user && activeAccessToken) {
        const profile = await getProfile(env, activeAccessToken, user.id);
        context.locals.session = { user, profile, accessToken: activeAccessToken };
      }
    } catch (err) {
      // A network hiccup or an actually-invalid refresh token both just
      // mean "treat this request as logged out" — never fail the request.
      console.error('Auth middleware error:', err);
    }
  }

  // "View as Visitor" (see src/lib/auth.ts's isAdminView doc comment):
  // computed on every request, not just /admin ones, since the footer
  // toggle that flips this cookie renders on every page. Deliberately
  // independent of the /admin route gate below, which stays keyed on the
  // REAL role — previewing the public site as a visitor should never lock
  // a real admin out of the admin panel itself.
  context.locals.isRealAdmin = context.locals.session?.profile?.role === 'admin';
  context.locals.viewAsVisitor = context.locals.isRealAdmin && context.cookies.get(VIEW_MODE_COOKIE)?.value === 'visitor';

  const pathname = context.url.pathname;
  const isAdminRoute = pathname.startsWith(ADMIN_PREFIX);
  const isPublicAdminPath = PUBLIC_ADMIN_PATHS.has(pathname);

  // Was a bare `return` for the redirect case, with a second `return next();`
  // below covering everything else — rewritten to funnel both outcomes
  // through one `response` variable so the cache-write check after this
  // block runs uniformly no matter which path produced the response.
  let response: Response;
  if (isAdminRoute && !isPublicAdminPath) {
    const session = context.locals.session;
    if (!session || session.profile?.role !== 'admin') {
      response = context.redirect(`/login?next=${encodeURIComponent(pathname)}`, 302);
    } else {
      response = await next();
    }
  } else {
    response = await next();
  }

  // --- Edge cache write (GET, anonymous, successful, opt-in pages only) ---
  //
  // Deliberately conservative — every condition below has to hold before
  // anything lands in the shared edge cache:
  //   - GET only (never cache the result of a POST/form action)
  //   - no session at all (`!context.locals.session`) — the one rule that
  //     matters most; see the read-side comment above for why this (rather
  //     than enumerating admin-aware pages) is the safety net
  //   - response.status === 200 (never cache a redirect, 404, or error page)
  //   - no Set-Cookie header (defensive — a response setting cookies isn't
  //     something the next visitor should be handed verbatim)
  //   - the page's own Cache-Control opted in with "public" — this respects
  //     each page's existing per-page header rather than a blanket policy
  //     here, so a page that never set one (or set `private`) is never
  //     cached even though it otherwise qualifies
  //
  // `response` here is a normal, fresh Response (either `next()`'s own, or
  // one we just constructed via `context.redirect()`) — never the immutable
  // object `cache.match()` returns, so `.clone()`ing it for the write is
  // safe and unrelated to this file's own read-side pitfall (see top of
  // file). No hand-rolled stale-while-revalidate here (serve-stale-then-
  // refresh-in-background) — this is intentionally just "fresh cache hit,
  // or full recompute," the simpler of the two. `waitUntil` runs the write
  // in the background so it never delays the response reaching this
  // visitor, and `.clone()` is required because a Response body can only be
  // read once, and the real body still needs to reach them.
  if (
    cache &&
    isCacheableMethod &&
    !context.locals.session &&
    response.status === 200 &&
    !response.headers.has('Set-Cookie') &&
    (response.headers.get('Cache-Control') ?? '').includes('public')
  ) {
    context.locals.runtime.ctx.waitUntil(cache.put(context.request, response.clone()));
  }

  // --- Site analytics (0077_page_views.sql, 0080_page_views_status_and_stats.sql) ---
  //
  // One row per real hit on an actual public page: GET only, never /admin or
  // /api (nothing under either is "content" a visitor browsed), never a real
  // admin's own traffic (`isRealAdmin` — otherwise Logan's own admin-panel
  // work would skew "unique visitors" on the very dashboard showing them).
  // Logs both a genuine page view (status 200) AND an error a visitor
  // actually hit (status >= 400 — 404s, 500s) so the dashboard's "Most
  // Common Errors" card has something to show; a 3xx redirect is neither (a
  // bounce, not a page view or an error) and is deliberately excluded. Only
  // runs on the deployed Worker — same `context.locals.runtime`
  // optional-chaining reasoning as the edge cache above: local `astro dev`
  // has neither `runtime.cf` (for country) nor `runtime.ctx.waitUntil` (to
  // fire this without delaying the response), and page views from a dev
  // machine wouldn't mean anything on the real dashboard anyway. Fired via
  // `waitUntil` so a slow/failed insert never adds latency to the actual
  // response, same reasoning as the cache write just above.
  if (
    context.locals.runtime &&
    context.request.method === 'GET' &&
    !pathname.startsWith(ADMIN_PREFIX) &&
    !pathname.startsWith('/api') &&
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
      })()
    );
  }

  return response;
});
