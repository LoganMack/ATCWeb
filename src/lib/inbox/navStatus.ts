/**
 * GET /api/nav-status's work (notifications U3; BR1.3, NFR1): one request per page fills both the bell dot
 * and the Admin Panel gear badge. Each part runs only for the accounts that see it, both in parallel, and a
 * part that fails is left out so the other still shows.
 */
import { restGetAuthed, type SupabaseEnv } from '../db/client';
import { getUnreadCount } from '../db/notifications';

export interface NavStatus {
  unread?: number;
  pendingSignups?: number;
}

export interface NavStatusInput {
  env: SupabaseEnv;
  accessToken: string;
  /** The account is linked to a driver, so it has the bell (BR1.1). */
  hasDriver: boolean;
  /** The account sees the Admin Panel gear (isAdminView), as /api/pending-signups requires. */
  canSeePanel: boolean;
}

/** Pending sign-up requests, read with the caller's token as /api/pending-signups does, so RLS applies. */
export async function getPendingSignupCount(env: SupabaseEnv, accessToken: string): Promise<number> {
  const rows = await restGetAuthed<{ id: string }[]>(
    env,
    accessToken,
    'signup_requests?select=id&status=eq.pending',
  );
  return rows.length;
}

/** The status number of a failed request, never its text, which may echo the request. */
function failureStatus(err: unknown): string {
  return err instanceof Error ? (/\b(\d{3})\b/.exec(err.message)?.[1] ?? 'unknown') : 'unknown';
}

export async function loadNavStatus(input: NavStatusInput): Promise<NavStatus> {
  const [unread, pending] = await Promise.allSettled([
    input.hasDriver ? getUnreadCount(input.env, input.accessToken) : Promise.resolve(undefined),
    input.canSeePanel ? getPendingSignupCount(input.env, input.accessToken) : Promise.resolve(undefined),
  ]);
  const status: NavStatus = {};
  if (unread.status === 'fulfilled') {
    if (unread.value !== undefined) status.unread = unread.value;
  } else {
    console.error('nav status: unread count failed', failureStatus(unread.reason));
  }
  if (pending.status === 'fulfilled') {
    if (pending.value !== undefined) status.pendingSignups = pending.value;
  } else {
    console.error('nav status: pending sign-ups failed', failureStatus(pending.reason));
  }
  return status;
}
