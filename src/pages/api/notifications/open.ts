import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../../lib/db/client';
import { openNotifications } from '../../../lib/db/notifications';
import { toNotificationItem } from '../../../lib/inbox/messages';

export const prerender = false;

/**
 * Opening the bell's popup (notifications U3, BR2.1): lists the caller's 50 newest notifications, with text
 * and links built here, and marks those read in the same database call. No CSRF token: it only marks the
 * caller's own rows, and the session cookie is SameSite=Lax, so a cross-site POST arrives signed out.
 * Astro's own origin check skips this request (it has no form body), so a foreign Origin is refused here too.
 */
export const POST: APIRoute = async ({ locals, request, url }) => {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) return json({ error: 'Cross-site request refused' }, 403);
  const session = locals.session;
  if (!session) return json({ error: 'Sign in first' }, 401);
  try {
    const { items, unreadLeft } = await openNotifications(resolveSupabaseEnv(locals), session.accessToken);
    return json({ items: items.map(toNotificationItem), unread: unreadLeft }, 200);
  } catch (err) {
    // The status only: an error's text may echo the request.
    const status = err instanceof Error ? (/\b(\d{3})\b/.exec(err.message)?.[1] ?? 'unknown') : 'unknown';
    console.error('Failed to open notifications', status);
    return json({ error: "Couldn't load notifications" }, 502);
  }
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
