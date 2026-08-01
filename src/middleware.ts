/**
 * Runs on every on-demand-rendered request (i.e. every `prerender = false`
 * page — prerendered pages never hit this at request time, same as they
 * never see Astro.locals.runtime.env).
 *
 * Three jobs, in order:
 *   1. Resolve the session from cookies, silently refreshing an expired
 *      access token via the refresh token.
 *   2. Build the request's data-access layer, bound to the env and to
 *      whichever token step 1 ended up with, and expose it as
 *      `Astro.locals.db`. Pages never touch env or tokens themselves.
 *   3. Gate everything under /admin behind "signed in AND role === 'admin'".
 */

import { defineMiddleware } from 'astro:middleware';
import { resolveEnv } from './lib/env';
import { createDb } from './lib/db';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_MAX_AGE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_MAX_AGE,
  authCookieOptions,
  getUser,
  refreshSession,
  type AuthUser,
} from './lib/auth';

const ADMIN_PREFIX = '/admin';
// Paths under /admin that must stay reachable without a session (the login
// page itself — redirecting it to itself would be an infinite loop).
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login']);

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.session = null;

  const env = resolveEnv(context.locals);
  const accessToken = context.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = context.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

  let activeAccessToken: string | null = null;
  let user: AuthUser | null = null;

  if (env.supabaseUrl && env.supabaseAnonKey && (accessToken || refreshToken)) {
    try {
      activeAccessToken = accessToken ?? null;
      user = activeAccessToken ? await getUser(env, activeAccessToken) : null;

      // Access token missing or expired — fall back to the refresh token
      // before treating the visitor as logged out.
      if (!user && refreshToken) {
        const refreshed = await refreshSession(env, refreshToken);
        activeAccessToken = refreshed.accessToken;
        user = refreshed.user;
        const cookieOptions = authCookieOptions(context.url);
        context.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, {
          ...cookieOptions,
          maxAge: ACCESS_TOKEN_MAX_AGE,
        });
        context.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, {
          ...cookieOptions,
          maxAge: REFRESH_TOKEN_MAX_AGE,
        });
      }
    } catch (err) {
      // A network hiccup and a genuinely invalid refresh token both just
      // mean "treat this request as logged out" — never fail the request.
      console.error('Auth middleware error:', err);
      activeAccessToken = null;
      user = null;
    }
  }

  // Always present, signed in or not. Public reads go out under the anon key;
  // with a token bound, RLS-gated reads and every write become available.
  const db = createDb(env, activeAccessToken);
  context.locals.db = db;

  if (user && activeAccessToken) {
    // Returns null (rather than throwing) if the profile can't be read, so a
    // half-broken profile still resolves to a signed-in-but-not-admin user.
    const profile = await db.profiles.getById(user.id);
    context.locals.session = { user, profile, accessToken: activeAccessToken };
  }

  const pathname = context.url.pathname;
  const isAdminRoute = pathname.startsWith(ADMIN_PREFIX);
  const isPublicAdminPath = PUBLIC_ADMIN_PATHS.has(pathname);

  if (isAdminRoute && !isPublicAdminPath) {
    const session = context.locals.session;
    if (!session || session.profile?.role !== 'admin') {
      return context.redirect(`/admin/login?next=${encodeURIComponent(pathname)}`, 302);
    }
  }

  return next();
});
