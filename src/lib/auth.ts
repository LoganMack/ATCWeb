/**
 * Auth — interim implementation.
 *
 * The user's explicit long-term requirement is "Login with iRacing" OAuth
 * (see https://oauth.iracing.com/oauth2/book/), for GDPR/EU-privacy reasons
 * (iRacing's profile endpoint returns only { iracing_cust_id, iracing_name }
 * — no email). iRacing has currently PAUSED new OAuth client registration,
 * so a real integration can't be built/tested yet. Per the user's explicit
 * choice, this file implements a working interim login using Supabase's own
 * Auth (GoTrue) REST API — plain `fetch`, no @supabase/supabase-js, matching
 * the rest of this codebase — so admin tools are usable today. The schema
 * (see supabase/migrations/0002_auth_admin.sql — `profiles.iracing_cust_id`
 * / `iracing_name`) is already shaped so a real iRacing login can be added
 * later as an additional way to populate/link the same `profiles` row,
 * without reworking anything built on top of it.
 *
 * All of GoTrue's REST endpoints require the `apikey` header (the anon key)
 * in addition to whatever `Authorization` bearer token is relevant to the
 * call — that's a Supabase-wide REST requirement, not specific to auth.
 */

import type { SupabaseEnv } from './supabase';

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

export interface Profile {
  id: string;
  role: 'admin' | 'driver';
  display_name: string | null;
  driver_id: string | null;
  iracing_cust_id: number | null;
  iracing_name: string | null;
}

function authHeaders(env: SupabaseEnv, accessToken?: string) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${accessToken ?? env.anonKey}`,
    'Content-Type': 'application/json',
  };
}

interface GoTrueTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string | null };
}

/** Email/password sign-in against Supabase Auth. Throws on bad credentials. */
export async function signInWithPassword(
  env: SupabaseEnv,
  email: string,
  password: string
): Promise<Session> {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-in failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as GoTrueTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    user: { id: data.user.id, email: data.user.email },
  };
}

/**
 * Result of a sign-up attempt. `session` is null when the account needs
 * email confirmation before it can sign in (GoTrue's default "Confirm
 * email" setting) — the account was still created, there's just no active
 * session yet. `session` is populated when confirmation isn't required
 * (or wasn't required for this particular attempt), exactly like a normal
 * sign-in, so the caller can log the person straight in.
 */
export interface SignUpResult {
  session: Session | null;
}

interface GoTrueSignUpResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id: string; email: string | null } | null;
  id?: string;
  email?: string | null;
}

/**
 * Public self-service sign-up against Supabase Auth. A `profiles` row
 * (role: 'driver') is created automatically by the `on_auth_user_created`
 * trigger (see supabase/migrations/0002_auth_admin.sql) — no app-side
 * plumbing needed for that part.
 *
 * Note on existing emails: GoTrue deliberately avoids confirming or denying
 * whether an email is already registered (a standard anti-enumeration
 * measure), so a repeat sign-up for an existing, already-confirmed address
 * can come back looking like success without actually creating or changing
 * anything — there's no reliable way to distinguish that case from a
 * genuine new sign-up from this response alone.
 */
export async function signUp(
  env: SupabaseEnv,
  email: string,
  password: string,
  displayName?: string
): Promise<SignUpResult> {
  const res = await fetch(`${env.url}/auth/v1/signup`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      email,
      password,
      data: displayName ? { display_name: displayName } : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-up failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as GoTrueSignUpResponse;

  // access_token is only present when no email confirmation is required —
  // otherwise this response is just the (unconfirmed) user row.
  if (data.access_token && data.refresh_token && data.expires_in && data.user) {
    return {
      session: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        user: { id: data.user.id, email: data.user.email },
      },
    };
  }
  return { session: null };
}

/** Exchange a refresh token for a new session. Throws if the refresh token is invalid/expired. */
export async function refreshSession(env: SupabaseEnv, refreshToken: string): Promise<Session> {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Session refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as GoTrueTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    user: { id: data.user.id, email: data.user.email },
  };
}

/** Revoke a refresh token server-side (best-effort — logout still clears cookies even if this fails). */
export async function revokeSession(env: SupabaseEnv, accessToken: string): Promise<void> {
  await fetch(`${env.url}/auth/v1/logout`, {
    method: 'POST',
    headers: authHeaders(env, accessToken),
  }).catch(() => {
    // Best-effort — an expired/invalid token here shouldn't block logout.
  });
}

/** Validate an access token and return the user it belongs to, or null if it's missing/expired/invalid. */
export async function getUser(env: SupabaseEnv, accessToken: string): Promise<AuthUser | null> {
  const res = await fetch(`${env.url}/auth/v1/user`, {
    headers: authHeaders(env, accessToken),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id: string; email: string | null };
  return { id: data.id, email: data.email };
}

/** Fetch a profile row. Uses the caller's own access token, so RLS decides what's visible. */
export async function getProfile(
  env: SupabaseEnv,
  accessToken: string,
  userId: string
): Promise<Profile | null> {
  const select = 'id,role,display_name,driver_id,iracing_cust_id,iracing_name';
  const res = await fetch(`${env.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${select}`, {
    headers: authHeaders(env, accessToken),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Profile[];
  return rows[0] ?? null;
}

/** All profiles, for the admin "assign roles" screen. Requires an admin's access token (RLS-enforced). */
export async function getAllProfiles(env: SupabaseEnv, accessToken: string): Promise<Profile[]> {
  const select = 'id,role,display_name,driver_id,iracing_cust_id,iracing_name';
  const res = await fetch(`${env.url}/rest/v1/profiles?select=${select}&order=created_at.asc`, {
    headers: authHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(`Failed to load profiles (${res.status}): ${await res.text()}`);
  return res.json() as Promise<Profile[]>;
}

/** Update a profile's role. Requires an admin's access token — RLS rejects this otherwise. */
export async function setProfileRole(
  env: SupabaseEnv,
  accessToken: string,
  profileId: string,
  role: 'admin' | 'driver'
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(env, accessToken), Prefer: 'return=minimal' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`Failed to update role (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_COOKIE = 'atc_at';
export const REFRESH_TOKEN_COOKIE = 'atc_rt';
export const AUTH_COOKIE_PATH = '/';

/**
 * Cookie options shared by both auth cookies — HttpOnly so client JS can
 * never read the tokens. `secure` is derived from the request's own URL
 * rather than hardcoded `true`: a `Secure` cookie is silently dropped by the
 * browser on a plain-http origin (e.g. `astro dev` on http://localhost),
 * which otherwise looks exactly like "login silently fails" — the sign-in
 * call succeeds and the redirect to /admin fires, but the cookie never
 * actually gets stored, so the middleware immediately bounces you back to
 * /admin/login with nothing on screen to explain why. On the real Cloudflare
 * deployment (always https) this still resolves to `true` as before.
 */
export function authCookieOptions(url: URL) {
  return {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax' as const,
    path: AUTH_COOKIE_PATH,
  };
}

// ---------------------------------------------------------------------------
// "View as Visitor" (admin impersonation preview)
// ---------------------------------------------------------------------------

/**
 * Set to 'visitor' when a real admin has toggled "View as Visitor" in the
 * footer, so they can click through the site the way a non-admin would to
 * assess UI changes without actually signing out. Read/written in
 * src/middleware.ts and src/pages/api/view-mode.ts; httpOnly like the auth
 * cookies since there's no reason client JS needs to touch it.
 */
export const VIEW_MODE_COOKIE = 'atc_view_mode';

/**
 * The one check every admin-gated page/component OUTSIDE of /admin itself
 * should use instead of `locals.session?.profile?.role === 'admin'` — see
 * `viewAsVisitor`'s doc comment in src/env.d.ts for why /admin/* pages
 * deliberately don't use this (they stay real-admin-only regardless of the
 * preview toggle).
 */
export function isAdminView(locals: App.Locals): boolean {
  return locals.session?.profile?.role === 'admin' && !locals.viewAsVisitor;
}
