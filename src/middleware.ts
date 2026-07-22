/**
 * Runs on every on-demand-rendered request (i.e. every `prerender = false`
 * page — prerendered/static pages never hit this at request time, same as
 * they never see Astro.locals.runtime.env). Resolves the current session
 * from cookies (refreshing it if the access token expired) and gates
 * everything under /admin behind "logged in AND role === 'admin'".
 *
 * Session state is exposed as `Astro.locals.session` for every page/API
 * route, so nothing downstream needs to touch cookies directly.
 */

import { defineMiddleware } from 'astro:middleware';
import { resolveSupabaseEnv } from './lib/supabase';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  AUTH_COOKIE_OPTIONS,
  getUser,
  getProfile,
  refreshSession,
} from './lib/auth';

const ADMIN_PREFIX = '/admin';
// Paths under /admin that must stay reachable without a session (the login
// page itself — redirecting it to itself would be an infinite loop).
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login']);

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.session = null;

  const env = resolveSupabaseEnv(context.locals);
  const accessToken = context.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = context.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

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
        context.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, {
          ...AUTH_COOKIE_OPTIONS,
          maxAge: 60 * 60, // access tokens are short-lived; this just bounds the cookie's own lifetime
        });
        context.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, {
          ...AUTH_COOKIE_OPTIONS,
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
