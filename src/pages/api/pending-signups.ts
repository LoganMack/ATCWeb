import type { APIRoute } from 'astro';
import { resolveSupabaseEnv, restGetAuthed } from '../../lib/supabase';
import { isAdminView } from '../../lib/auth';

export const prerender = false;

/**
 * JSON endpoint behind the pending sign-ups badge on the nav's Admin Panel
 * gear (src/components/Nav.astro, #64): `{ count }` of sign-up requests still
 * waiting on a decision. Fetched by the browser after the page renders rather
 * than counted during it, since the nav appears on every admin page view and
 * those are never edge-cached. Same count as the admin dashboard's Sign-ups
 * card; the admin's own token, so the table's RLS still applies.
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
