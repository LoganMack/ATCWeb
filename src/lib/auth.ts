/**
 * Interim auth on Supabase Auth (GoTrue) over plain `fetch`. The goal is "Login with iRacing" OAuth for
 * privacy (no email), but iRacing has paused new OAuth clients; the `profiles` schema (0002) already has the
 * iRacing fields so it can be added later. Every GoTrue call needs the `apikey` header as well as any bearer
 * token.
 */

import type { SupabaseEnv } from './db/client';
import privacyReads from './privacyReads.json';

export interface AuthUser {
  id: string;
  email: string | null;
  /**
   * The address an email change is waiting to be confirmed for (GoTrue's `new_email`), null when none.
   * Only getUser reads it; a session from a token refresh leaves it undefined.
   */
  newEmail?: string | null;
}

/** A failed GoTrue request, carrying its HTTP status so callers can tell a rate limit (429) apart. */
export class AuthRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  user: AuthUser;
}

/** Admin and Staff both have panel access; only Admin is a full Admin (20261109120000_staff_role_and_broadcaster.sql). */
export type ProfileRole = 'admin' | 'staff' | 'driver';

export interface Profile {
  id: string;
  role: ProfileRole;
  display_name: string | null;
  driver_id: string | null;
  iracing_cust_id: number | null;
  iracing_name: string | null;
  /** The one Broadcaster account: never linked to a driver, privileged in masking, the only one with View as Broadcaster. */
  is_broadcaster: boolean;
  /** Name of the roster driver this login is linked to (profiles.driver_id), or null when unlinked. Wherever the site shows "who" a user is, this wins over display_name — see userDisplayName. */
  driver_name: string | null;
}

/** Raw PostgREST row: the embedded `driver:drivers_shown!driver_id(name)` join, before it's flattened into `driver_name`. */
type ProfileRow = Omit<Profile, 'driver_name'> & { driver: { name: string } | null };

const PROFILE_SELECT_PLAIN = 'id,role,display_name,driver_id,iracing_cust_id,iracing_name,is_broadcaster';
// Through the masked drivers_shown (U4): a linked user and an admin are privileged, so the name is real.
// Shared with the CI embed check.
const PROFILE_SELECT = privacyReads.profile.select;

function toProfile({ driver, ...rest }: ProfileRow): Profile {
  return { ...rest, is_broadcaster: rest.is_broadcaster === true, driver_name: driver?.name ?? null };
}

/**
 * The name to show for a user anywhere the site says who someone is — the
 * linked roster driver's name when they're linked to one (Admin > Users >
 * Driver), else their display name, iRacing name, or finally their email.
 */
export function userDisplayName(
  profile:
    | { driver_name?: string | null; display_name?: string | null; iracing_name?: string | null }
    | null
    | undefined,
  email?: string | null,
): string {
  return profile?.driver_name || profile?.display_name || profile?.iracing_name || email || 'Unknown';
}

function authHeaders(env: SupabaseEnv, accessToken?: string) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${accessToken ?? env.anonKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * The readable message from a GoTrue JSON error (`msg` or `error_description`), falling back to the raw body
 * when it isn't JSON.
 */
function goTrueErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { msg?: string; error_description?: string; message?: string };
    const text = parsed.msg || parsed.error_description || parsed.message;
    if (text) return text;
  } catch {
    // Not JSON — fall through to the raw body below.
  }
  return `Request failed (${status}): ${body}`;
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
  password: string,
): Promise<Session> {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(goTrueErrorMessage(res.status, await res.text()));
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
 * What a sign-up attempt led to: signed in straight away (no email confirmation required), a confirmation
 * email to follow, or an address that already has an account.
 */
export type SignUpResult =
  { kind: 'session'; session: Session } | { kind: 'confirm-email' } | { kind: 'email-in-use' };

interface GoTrueSignUpResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id: string; email: string | null } | null;
  id?: string;
  email?: string | null;
  identities?: unknown[];
}

const EMAIL_IN_USE_MESSAGE = /already (been )?registered|already exists/i;

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns a GoTrue `/signup` response into a SignUpResult; throws for any failure other than "email in use".
 * With "Confirm email" on, GoTrue answers a repeat sign-up for a confirmed address with an obfuscated user
 * whose `identities` list is empty (and sends no email), so that empty list is how a duplicate is spotted.
 */
export function classifySignUpResponse(status: number, body: string): SignUpResult {
  const parsed = parseJsonObject(body);
  if (status < 200 || status >= 300) {
    const message = goTrueErrorMessage(status, body);
    if (parsed?.error_code === 'user_already_exists' || EMAIL_IN_USE_MESSAGE.test(message)) {
      return { kind: 'email-in-use' };
    }
    throw new Error(message);
  }

  const data = (parsed ?? {}) as GoTrueSignUpResponse;
  if (data.access_token && data.refresh_token && data.expires_in && data.user) {
    return {
      kind: 'session',
      session: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
        user: { id: data.user.id, email: data.user.email },
      },
    };
  }
  if (Array.isArray(data.identities)) {
    return data.identities.length === 0 ? { kind: 'email-in-use' } : { kind: 'confirm-email' };
  }
  // Keys only, never values: the body holds the email address. A GoTrue change shows up here in the logs.
  console.warn('signUp: unrecognised GoTrue response shape', Object.keys(data));
  return { kind: 'confirm-email' };
}

/**
 * Public self-service sign-up; the `on_auth_user_created` trigger (0002) creates the driver profile. The
 * email is trimmed and lower-cased first so the duplicate check matches however the address was typed.
 */
export async function signUp(
  env: SupabaseEnv,
  email: string,
  password: string,
  displayName?: string,
  redirectTo?: string,
): Promise<SignUpResult> {
  const url = new URL(`${env.url}/auth/v1/signup`);
  // Without redirect_to the confirmation link uses the dashboard's Site URL (localhost by default). GoTrue
  // only honours origins in the project's Redirect URLs allowlist, which an admin sets once.
  if (redirectTo) url.searchParams.set('redirect_to', redirectTo);

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      password,
      data: displayName ? { display_name: displayName } : undefined,
    }),
  });
  return classifySignUpResponse(res.status, await res.text());
}

/**
 * Sends a password reset email. GoTrue returns 200 for unknown emails (anti-enumeration), so callers always
 * show the same confirmation; only a request failure throws. `redirectTo` decides where the link goes
 * (allowlisted as for signUp).
 */
export async function requestPasswordReset(
  env: SupabaseEnv,
  email: string,
  redirectTo: string,
): Promise<void> {
  const url = new URL(`${env.url}/auth/v1/recover`);
  url.searchParams.set('redirect_to', redirectTo);
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new AuthRequestError(res.status, goTrueErrorMessage(res.status, await res.text()));
  }
}

// --- Changing the account's email (U3 profile-settings, BR5.3) ----------------------------------

export const EMAIL_MAX_LENGTH = 254;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An address as typed, trimmed and lower-cased, or null unless it looks like an email of at most 254 characters. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
  return EMAIL_FORMAT.test(email) ? email : null;
}

export type ChangeEmailCode = 'INVALID' | 'EMAIL_IN_USE' | 'RATE_LIMITED' | 'UNKNOWN';
export type ChangeEmailResult = { ok: true; email: string } | { ok: false; code: ChangeEmailCode };

/** Maps a GoTrue error response from PUT /auth/v1/user to a code. */
export function classifyChangeEmailError(status: number, body: string): ChangeEmailCode {
  const parsed = parseJsonObject(body);
  const errorCode = typeof parsed?.error_code === 'string' ? parsed.error_code : '';
  if (status === 429 || errorCode === 'over_email_send_rate_limit') return 'RATE_LIMITED';
  if (errorCode === 'email_address_invalid') return 'INVALID';
  if (errorCode === 'email_exists' || EMAIL_IN_USE_MESSAGE.test(goTrueErrorMessage(status, body))) {
    return 'EMAIL_IN_USE';
  }
  if (status === 400) return 'INVALID';
  return 'UNKNOWN';
}

/** The host of a redirect target, for logs (the full URL holds a driver id; addresses are never logged). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Asks GoTrue to change the signed-in user's email. It sends a confirmation link (to the new address, and
 * to the old one too when the project's "Secure email change" is on); the address changes once confirmed.
 * `redirectTo` is where the link lands and must be in the project's Redirect URLs allowlist.
 */
export async function changeEmail(
  env: SupabaseEnv,
  accessToken: string,
  rawEmail: string,
  redirectTo: string,
): Promise<ChangeEmailResult> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, code: 'INVALID' };
  const url = new URL(`${env.url}/auth/v1/user`);
  url.searchParams.set('redirect_to', redirectTo);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: authHeaders(env, accessToken),
      body: JSON.stringify({ email }),
    });
  } catch {
    console.error('change-email failed', 'UNKNOWN');
    return { ok: false, code: 'UNKNOWN' };
  }
  if (!res.ok) {
    const code = classifyChangeEmailError(res.status, await res.text());
    console.error('change-email failed', code);
    return { ok: false, code };
  }
  // The redirect host is logged so a link landing on the wrong site can be matched to the allowlist.
  console.info('change-email sent', hostOf(redirectTo));
  return { ok: true, email };
}

/**
 * Sets a new password with the access token from the recovery link (see reset-password.astro). That
 * short-lived session token proves the request, so no old password is needed.
 */
export async function updatePassword(
  env: SupabaseEnv,
  recoveryAccessToken: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch(`${env.url}/auth/v1/user`, {
    method: 'PUT',
    headers: authHeaders(env, recoveryAccessToken),
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    throw new Error(goTrueErrorMessage(res.status, await res.text()));
  }
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
  const data = (await res.json()) as { id: string; email: string | null; new_email?: string | null };
  return { id: data.id, email: data.email, newEmail: data.new_email || null };
}

/** Fetch a profile row. Uses the caller's own access token, so RLS decides what's visible. */
export async function getProfile(
  env: SupabaseEnv,
  accessToken: string,
  userId: string,
): Promise<Profile | null> {
  const fetchRows = (select: string) =>
    fetch(
      `${env.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent(select)}`,
      {
        headers: authHeaders(env, accessToken),
      },
    );
  let res = await fetchRows(PROFILE_SELECT);
  // Every request in the app resolves the session through here, so if the
  // driver-name join ever fails, fall back to the plain columns rather than
  // treating a signed-in user as having no profile (which would lock admins out).
  if (!res.ok) res = await fetchRows(PROFILE_SELECT_PLAIN);
  if (!res.ok) return null;
  const rows = (await res.json()) as Partial<ProfileRow>[];
  return rows[0] ? toProfile({ driver: null, ...rows[0] } as ProfileRow) : null;
}

/** All profiles, for the admin "assign roles" screen. Requires an admin's access token (RLS-enforced). */
export async function getAllProfiles(env: SupabaseEnv, accessToken: string): Promise<Profile[]> {
  const res = await fetch(
    `${env.url}/rest/v1/profiles?select=${encodeURIComponent(PROFILE_SELECT)}&order=created_at.asc`,
    {
      headers: authHeaders(env, accessToken),
    },
  );
  if (!res.ok) throw new Error(`Failed to load profiles (${res.status}): ${await res.text()}`);
  return ((await res.json()) as ProfileRow[]).map(toProfile);
}

/** Every login's email address (id -> email), for Admin > Users. Emails live in auth.users, so this goes through the admin-only admin_list_user_emails() function (0095). Returns an empty map if that function isn't available. */
export async function getUserEmails(env: SupabaseEnv, accessToken: string): Promise<Map<string, string>> {
  try {
    const res = await fetch(`${env.url}/rest/v1/rpc/admin_list_user_emails`, {
      method: 'POST',
      headers: authHeaders(env, accessToken),
      body: '{}',
    });
    if (!res.ok) return new Map();
    const rows = (await res.json()) as { id: string; email: string | null }[];
    return new Map(rows.filter((r) => r.email).map((r) => [r.id, r.email as string]));
  } catch {
    return new Map();
  }
}

/** Deletes a login (and its profile) via the admin-only admin_delete_user() function (0095). Throws with the database's message on failure. */
export async function deleteUser(env: SupabaseEnv, accessToken: string, userId: string): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/admin_delete_user`, {
    method: 'POST',
    headers: authHeaders(env, accessToken),
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!res.ok) {
    let message = await res.text();
    try {
      message = (JSON.parse(message) as { message?: string }).message ?? message;
    } catch {
      // keep raw text
    }
    throw new Error(message);
  }
}

/** Links a login to a roster driver (or clears the link with `null`). Requires an admin's access token — RLS rejects this otherwise. */
export async function setProfileDriver(
  env: SupabaseEnv,
  accessToken: string,
  profileId: string,
  driverId: string | null,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(env, accessToken), Prefer: 'return=minimal' },
    body: JSON.stringify({ driver_id: driverId }),
  });
  if (!res.ok) throw new Error(`Failed to link driver (${res.status}): ${await res.text()}`);
}

/** Update a profile's role. Requires a full Admin's access token — the profiles guard rejects anyone else. */
export async function setProfileRole(
  env: SupabaseEnv,
  accessToken: string,
  profileId: string,
  role: ProfileRole,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(env, accessToken), Prefer: 'return=minimal' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`Failed to update role (${res.status}): ${await res.text()}`);
}

/**
 * Makes `profileId` the Broadcaster (moving it from any other account), or with null removes it, through the
 * full-Admin admin_set_broadcaster() function. Throws with the database's message, e.g. 'ACCOUNT_LINKED: ...'
 * for an account linked to a driver.
 */
export async function setBroadcaster(
  env: SupabaseEnv,
  accessToken: string,
  profileId: string | null,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/admin_set_broadcaster`, {
    method: 'POST',
    headers: authHeaders(env, accessToken),
    body: JSON.stringify({ p_profile_id: profileId }),
  });
  if (!res.ok) {
    let message = await res.text();
    try {
      message = (JSON.parse(message) as { message?: string }).message ?? message;
    } catch {
      // keep raw text
    }
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_COOKIE = 'atc_at';
export const REFRESH_TOKEN_COOKIE = 'atc_rt';
export const AUTH_COOKIE_PATH = '/';

/**
 * Shared options for both auth cookies, HttpOnly. `secure` follows the request URL because browsers drop
 * Secure cookies on http (astro dev), which looks like a silent login failure.
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
 * 'visitor' while an admin uses "View as Visitor" to browse as a non-admin without signing out. Set in
 * src/middleware.ts and api/view-mode.ts; httpOnly.
 */
export const VIEW_MODE_COOKIE = 'atc_view_mode';

/**
 * The admin check for pages outside /admin, which respects "View as Visitor"; /admin pages stay
 * panel-access-only (see `viewAsVisitor` in src/env.d.ts). Staff count, as everywhere outside Admin > Users
 * and the five restricted areas.
 */
export function isAdminView(locals: App.Locals): boolean {
  return hasPanelAccess(locals.session?.profile) && !locals.viewAsVisitor;
}

// ---------------------------------------------------------------------------
// Roles: panel access (Admin or Staff) and full Admin. The database enforces both; these only decide what
// to render and where to send a request.
// ---------------------------------------------------------------------------

type RoleHolder = { role?: string | null } | null | undefined;

/** Admin or Staff: may open /admin. */
export function hasPanelAccess(profile: RoleHolder): boolean {
  return profile?.role === 'admin' || profile?.role === 'staff';
}

/** Admin only: Admin > Users changes and the restricted areas. */
export function isFullAdmin(profile: RoleHolder): boolean {
  return profile?.role === 'admin';
}

/** The admin areas Staff can't open (BR2.7): Site Properties (and its champions sub-pages), Seasons, Rulesets, Media and Circuits. */
const STAFF_RESTRICTED_AREAS = [
  'site-properties',
  'champions',
  'seasons',
  'rulesets',
  'media',
  'circuits',
] as const;

/** Their /admin paths; everything under each is restricted too. */
export const STAFF_RESTRICTED_PREFIXES: readonly string[] = STAFF_RESTRICTED_AREAS.map(
  (area) => `/admin/${area}`,
);

/**
 * Canonical form of a request path for access-control decisions: fully percent-decoded, backslashes treated
 * as slashes, duplicate slashes collapsed, trailing slash dropped, lowercased. Null when the path has invalid
 * encoding (callers should fail closed).
 */
export function normalisePath(pathname: string): string | null {
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

/** True when a Staff member may not open this path. An undecodable path counts as restricted (fails closed). */
export function isStaffRestrictedPath(pathname: string): boolean {
  const p = normalisePath(pathname);
  if (p === null) return true;
  return STAFF_RESTRICTED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** The admin dashboard's tools this account may open: everything for a full Admin, no restricted area for Staff. */
export function adminToolsFor<T extends { href: string }>(tools: readonly T[], profile: RoleHolder): T[] {
  return isFullAdmin(profile) ? [...tools] : tools.filter((tool) => !isStaffRestrictedPath(tool.href));
}

// ---------------------------------------------------------------------------
// Typed admin session (replaces `Astro.locals.session!` in pages)
// ---------------------------------------------------------------------------

/** A signed-in session with panel access (the real role, Admin or Staff). */
export type AdminSession = NonNullable<App.Locals['session']> & {
  profile: Profile & { role: 'admin' | 'staff' };
};

/** A signed-in session whose profile has the real `admin` role. */
export type FullAdminSession = NonNullable<App.Locals['session']> & { profile: Profile & { role: 'admin' } };

/** The session when it has panel access (real role, as in the middleware), otherwise null. Never redirects. */
export function requireAdminSession(locals: App.Locals): AdminSession | null {
  const session = locals.session;
  return hasPanelAccess(session?.profile) ? (session as AdminSession) : null;
}

type GuardContext = {
  locals: App.Locals;
  url: URL;
  redirect: (path: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
};

/**
 * The session of a signed-in Admin or Staff member, or a redirect to the login page when there isn't one.
 * Same role test, target and status as the middleware's /admin gate, so on /admin pages this is a second
 * line of defence.
 */
export function requireAdmin(ctx: GuardContext): AdminSession | Response {
  return (
    requireAdminSession(ctx.locals) ??
    ctx.redirect('/login?next=' + encodeURIComponent(ctx.url.pathname), 302)
  );
}

/**
 * For the restricted areas and Admin > Users actions: the full Admin's session; Staff go back to the
 * dashboard, and anyone else to the login page.
 */
export function requireFullAdmin(ctx: GuardContext): FullAdminSession | Response {
  const session = ctx.locals.session;
  if (isFullAdmin(session?.profile)) return session as FullAdminSession;
  if (hasPanelAccess(session?.profile)) return ctx.redirect('/admin', 302);
  return ctx.redirect('/login?next=' + encodeURIComponent(ctx.url.pathname), 302);
}

/** The page where a signed-in account without a driver picks one (U2 driver-linking, C10). */
export const LINK_DRIVER_PATH = '/link-driver';

/** The Broadcaster account's own page (email and password only). */
export const BROADCASTER_PATH = '/broadcaster';

/** True when the signed-in account is the Broadcaster. */
export function isBroadcasterAccount(locals: App.Locals): boolean {
  return locals.session?.profile?.is_broadcaster === true;
}

/**
 * Where the header's My Profile link (`/my-profile`) leads (BR1.9): sign in first when signed out, then the
 * linked driver's page, the Broadcaster page, or the linking page for an account with neither.
 */
export function myProfilePath(locals: App.Locals): string {
  const session = locals.session;
  if (!session) return '/login?next=/my-profile';
  const driverId = session.profile?.driver_id;
  if (driverId) return `/drivers/${encodeURIComponent(driverId)}`;
  return isBroadcasterAccount(locals) ? BROADCASTER_PATH : LINK_DRIVER_PATH;
}

/** The header link's hover text and label, matching myProfilePath's destination. */
export function myProfileLabel(locals: App.Locals): 'My Profile' | 'Broadcaster' | 'Link Driver' {
  const session = locals.session;
  if (!session || session.profile?.driver_id) return 'My Profile';
  return isBroadcasterAccount(locals) ? 'Broadcaster' : 'Link Driver';
}

// ---------------------------------------------------------------------------
// "View as Broadcaster" (spoiler-free viewing for delayed broadcasts)
// ---------------------------------------------------------------------------

/**
 * '1' while the Broadcaster uses "View as Broadcaster": src/middleware.ts hides the latest round from every
 * statistic (SupabaseEnv.hiddenSubsessionIds in src/lib/db/client.ts). Set by api/broadcaster-mode.ts.
 */
export const BROADCASTER_COOKIE = 'atc_broadcaster';

/**
 * Whether this request renders in Broadcaster mode (BR1.8): only for the signed-in Broadcaster with the cookie
 * on. Anyone else's cookie is ignored. Presentation only: what the mode hides is public anyway.
 */
export function broadcasterModeFor(
  profile: { is_broadcaster?: boolean } | null | undefined,
  cookieValue: string | undefined,
): boolean {
  return profile?.is_broadcaster === true && cookieValue === '1';
}
