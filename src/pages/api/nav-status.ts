import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../lib/db/client';
import { isAdminView } from '../../lib/auth';
import { loadNavStatus } from '../../lib/inbox/navStatus';

export const prerender = false;

/**
 * `{ unread?, pendingSignups? }` for the nav's bell dot and Admin Panel badge (notifications U3, BR1.3),
 * fetched once per page after render. A part the account doesn't see, or one that failed, is left out.
 */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.session;
  if (!session) return json({ error: 'Sign in first' }, 401);
  const status = await loadNavStatus({
    env: resolveSupabaseEnv(locals),
    accessToken: session.accessToken,
    hasDriver: Boolean(session.profile?.driver_id),
    canSeePanel: isAdminView(locals),
  });
  return json(status, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
