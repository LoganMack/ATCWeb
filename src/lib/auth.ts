/**
 * Supabase Auth (GoTrue) token exchange + the session cookie contract.
 *
 * Scope note: this file is *only* about proving who someone is and keeping
 * that proof in a cookie. Reading and writing `profiles` rows — including
 * the role that decides who's an admin — is ordinary table access and lives
 * in src/lib/db/profiles.ts.
 *
 * INTERIM IMPLEMENTATION. The long-term requirement is "Login with iRacing"
 * OAuth (https://oauth.iracing.com/oauth2/book/), for GDPR/EU-privacy
 * reasons: iRacing's profile endpoint returns only
 * { iracing_cust_id, iracing_name } — no email. iRacing has currently PAUSED
 * new OAuth client registration, so that can't be built or tested yet. Until
 * it can, this uses Supabase's own email/password auth via plain `fetch` (no
 * @supabase/supabase-js, matching the rest of the codebase). The schema is
 * already shaped for the switch: `profiles.iracing_cust_id`/`iracing_name`
 * in 0002_auth_admin.sql just sit null until a real iRacing login populates
 * the same row, so adding it later doesn't rework anything built on top.
 *
 * Every GoTrue endpoint needs the `apikey` header (the anon key) in addition
 * to whatever bearer token the call itself uses — that's a Supabase-wide
 * REST requirement, not an auth-specific one.
 */

import type { SiteEnv } from './env';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  user: AuthUser;
}

function authHeaders(env: SiteEnv, accessToken?: string) {
  return {
    apikey: env.supabaseAnonKey,
    Authorization: `Bearer ${accessToken ?? env.supabaseAnonKey}`,
    'Content-Type': 'application/json',
  };
}

interface GoTrueTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string | null };
}

function toSession(data: GoTrueTokenResponse): Session {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    user: { id: data.user.id, email: data.user.email },
  };
}

/** Email/password sign-in. Throws on bad credentials. */
export async function signInWithPassword(
  env: SiteEnv,
  email: string,
  password: string
): Promise<Session> {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in failed (${res.status}): ${await res.text()}`);
  }
  return toSession((await res.json()) as GoTrueTokenResponse);
}

/** Exchange a refresh token for a new session. Throws if it's invalid or expired. */
export async function refreshSession(env: SiteEnv, refreshToken: string): Promise<Session> {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Session refresh failed (${res.status}): ${await res.text()}`);
  }
  return toSession((await res.json()) as GoTrueTokenResponse);
}

/** Revoke a refresh token server-side. Best-effort — logout clears cookies either way. */
export async function revokeSession(env: SiteEnv, accessToken: string): Promise<void> {
  await fetch(`${env.supabaseUrl}/auth/v1/logout`, {
    method: 'POST',
    headers: authHeaders(env, accessToken),
  }).catch(() => {
    // An expired/invalid token here shouldn't block logout.
  });
}

/** Validate an access token and return its user, or null if missing/expired/invalid. */
export async function getUser(env: SiteEnv, accessToken: string): Promise<AuthUser | null> {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: authHeaders(env, accessToken),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id: string; email: string | null };
  return { id: data.id, email: data.email };
}

// ---------------------------------------------------------------------------
// Cookie contract
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_COOKIE = 'atc_at';
export const REFRESH_TOKEN_COOKIE = 'atc_rt';
export const AUTH_COOKIE_PATH = '/';

/** Access tokens are short-lived; this only bounds the cookie's own lifetime. */
export const ACCESS_TOKEN_MAX_AGE = 60 * 60;
export const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Options shared by both auth cookies. HttpOnly so client JS can never read
 * the tokens. `secure` is derived from the request URL rather than hardcoded
 * to `true`: a Secure cookie is silently dropped by the browser on a plain
 * http origin (`astro dev` on http://localhost), which looks exactly like
 * "login fails for no reason" — the sign-in succeeds, the redirect fires,
 * but the cookie never gets stored, so the middleware bounces you straight
 * back to /admin/login. On Cloudflare (always https) this is still `true`.
 */
export function authCookieOptions(url: URL) {
  return {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax' as const,
    path: AUTH_COOKIE_PATH,
  };
}
