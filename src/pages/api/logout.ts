import type { APIRoute } from 'astro';
import { resolveEnv } from '../../lib/env';
import { revokeSession, ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, AUTH_COOKIE_PATH } from '../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  const session = locals.session;
  if (session) {
    await revokeSession(resolveEnv(locals), session.accessToken);
  }
  cookies.delete(ACCESS_TOKEN_COOKIE, { path: AUTH_COOKIE_PATH });
  cookies.delete(REFRESH_TOKEN_COOKIE, { path: AUTH_COOKIE_PATH });
  return redirect('/admin/login', 302);
};
