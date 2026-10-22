import type { APIRoute } from 'astro';
import { resolveSupabaseEnv, restGetAuthed } from '../../lib/db/client';
import { isAdminView } from '../../lib/auth';

export const prerender = false;

/**
 * `{ count }` of pending sign-ups for the admin gear badge (#64), fetched after render because admin pages
 * aren't cached. Uses the admin's token, so RLS applies.
 */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.session;
  if (!session || !isAdminView(locals)) return json({ error: 'Forbidden' }, 403);
  try {
    const rows = await restGetAuthed<{ id: string }[]>(
      resolveSupabaseEnv(locals),
      session.accessToken,
      'signup_requests?select=id&status=eq.pending',
    );
    return json({ count: rows.length }, 200);
  } catch (err) {
    console.error('Failed to load pending sign-up count for the nav:', err);
    return json({ error: 'Failed to load pending sign-ups' }, 500);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
