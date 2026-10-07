/**
 * Discord sign-up requests (0098_signup_requests.sql, docs/signup-integration.md).
 *
 * Two kinds of caller:
 *   - The bot API (src/pages/api/bot/) — no signed-in user, so it checks the
 *     bot's shared token (BOT_API_TOKEN) and then calls the service-role-only
 *     database functions with SUPABASE_SERVICE_ROLE_KEY. Both are Cloudflare
 *     secrets (`wrangler secret put`), never in wrangler.jsonc's `vars` or the
 *     repo; locally they come from .env.
 *   - Admin > Sign-ups — a signed-in admin's own token, same as every other
 *     admin write (RLS / is_admin() do the gating).
 */

import { resolveSupabaseEnv, restGet, restGetAuthed, type SupabaseEnv } from './supabase';

// --- Bot API side ------------------------------------------------------------

export interface BotApiEnv {
  url: string | undefined;
  serviceKey: string | undefined;
  botToken: string | undefined;
}

export function resolveBotApiEnv(locals: App.Locals): BotApiEnv {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string | undefined> } } | undefined)?.runtime?.env;
  return {
    url: resolveSupabaseEnv(locals).url,
    serviceKey: runtimeEnv?.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.SUPABASE_SERVICE_ROLE_KEY,
    botToken: runtimeEnv?.BOT_API_TOKEN || import.meta.env.BOT_API_TOKEN,
  };
}

/**
 * True when the request carries `Authorization: Bearer <BOT_API_TOKEN>`.
 * Compares SHA-256 digests in constant time so response timing can't leak
 * how much of a guessed token was right. Always false when no token is
 * configured, so a missing secret fails closed.
 */
export async function isAuthorizedBot(request: Request, expectedToken: string | undefined): Promise<boolean> {
  if (!expectedToken) return false;
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(match[1]), digest(expectedToken)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A database error the caller caused (bad input) rather than a server fault. */
export class SignupInputError extends Error {}

/** PostgREST error bodies are JSON with a `message`; fall back to the raw text. */
async function readDbError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}

/**
 * Calls a service-role-only database function. Messages starting with
 * "invalid:" (raised by submit_signup_request's validation) become a
 * SignupInputError so the endpoint can answer 400 instead of 500.
 */
export async function serviceRpc<T>(env: BotApiEnv, fn: string, args: Record<string, unknown>): Promise<T> {
  if (!env.url || !env.serviceKey) {
    throw new Error('Supabase URL or SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const message = await readDbError(res);
    if (message.startsWith('invalid:')) throw new SignupInputError(message.slice('invalid:'.length).trim());
    throw new Error(`Supabase rpc error ${res.status} on ${fn}: ${message}`);
  }
  return (await res.json()) as T;
}

export type SubmitSignupResult =
  | { status: 'pending'; request_id: string; assigned_number: number; taken: { number: number; holder: string }[] }
  | { status: 'all_taken'; taken: { number: number; holder: string }[] };

export interface PendingRejection {
  request_id: string;
  discord_user_id: string;
  name: string;
  reason: string;
}

/** JSON response with no caching — these endpoints must never hit the edge cache. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// --- Admin side --------------------------------------------------------------

export interface SignupRequest {
  id: string;
  discord_user_id: string;
  discord_username: string | null;
  name: string;
  iracing_cust_id: number | null;
  requested_numbers: number[];
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  driver_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  notified_at: string | null;
  created_at: string;
}

/** Pending requests (oldest first) plus the most recent decided ones. */
export async function getSignupRequests(
  env: SupabaseEnv,
  accessToken: string,
  recentDecidedLimit = 25
): Promise<{ pending: SignupRequest[]; decided: SignupRequest[] }> {
  const [pending, decided] = await Promise.all([
    restGetAuthed<SignupRequest[]>(env, accessToken, 'signup_requests?select=*&status=eq.pending&order=created_at.asc'),
    restGetAuthed<SignupRequest[]>(
      env,
      accessToken,
      `signup_requests?select=*&status=neq.pending&order=decided_at.desc&limit=${recentDecidedLimit}`
    ),
  ]);
  return { pending, decided };
}

async function adminRpc<T>(env: SupabaseEnv, accessToken: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  // The database's own messages ("None of the requested numbers is free any
  // more — reject this sign-up instead") are written to be shown to the admin.
  if (!res.ok) throw new Error(await readDbError(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export function approveSignupRequest(
  env: SupabaseEnv,
  accessToken: string,
  input: { request_id: string; name: string; iracing_cust_id: number | null; class_id: number; driver_id: string | null }
): Promise<{ driver_id: string; car_number: number }> {
  return adminRpc(env, accessToken, 'approve_signup_request', {
    p_request_id: input.request_id,
    p_name: input.name,
    p_iracing_cust_id: input.iracing_cust_id,
    p_class_id: input.class_id,
    p_driver_id: input.driver_id,
  });
}

export function rejectSignupRequest(env: SupabaseEnv, accessToken: string, requestId: string, reason: string): Promise<void> {
  return adminRpc(env, accessToken, 'reject_signup_request', { p_request_id: requestId, p_reason: reason });
}

/** The roster fields Admin > Sign-ups needs for returning-driver matching and number checks. */
export interface SignupRosterDriver {
  id: string;
  name: string;
  car_number: number | null;
  iracing_cust_id: number | null;
  class_id: number;
  driver_statuses: { name: string } | null;
}

export function getSignupRoster(env: SupabaseEnv): Promise<SignupRosterDriver[]> {
  const select = 'id,name,car_number,iracing_cust_id,class_id,driver_statuses(name)';
  return restGet<SignupRosterDriver[]>(env, `drivers?select=${encodeURIComponent(select)}&is_ai=eq.false`);
}

/**
 * Who blocks `number` for someone else — mirrors the database's
 * car_number_holder() (0098): any driver holding it whose status isn't
 * Inactive, other than `excludeDriverId`. Only a preview for the admin page;
 * approval re-checks in the database.
 */
export function numberHolder(roster: SignupRosterDriver[], number: number, excludeDriverId: string | null = null) {
  return (
    roster.find(
      (d) => d.car_number === number && d.driver_statuses?.name !== 'Inactive' && d.id !== excludeDriverId
    ) ?? null
  );
}

/** Likely existing roster entries for a sign-up: same iRacing ID, or same name ignoring case. */
export function returningCandidates(roster: SignupRosterDriver[], request: Pick<SignupRequest, 'name' | 'iracing_cust_id'>) {
  const name = request.name.trim().toLowerCase();
  return roster.filter(
    (d) =>
      (request.iracing_cust_id !== null && d.iracing_cust_id === request.iracing_cust_id) || d.name.trim().toLowerCase() === name
  );
}

/** Preset rejection reasons offered on Admin > Sign-ups (a custom one can be typed instead). */
export const SIGNUP_REJECTION_REASONS = [
  'Your number choices are no longer available. Please sign up again with different numbers.',
  'Duplicate sign-up — you already have a sign-up being processed.',
  'We could not verify your iRacing account. Please contact an admin.',
];
