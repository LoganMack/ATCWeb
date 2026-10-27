import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../../../lib/db/client';
import { signMemberInterviewAudio } from '../../../../lib/interviewsFeed';

export const prerender = false;

/**
 * One interview's audio for History > Interviews (driver-profile-polish FR8.4): a redirect to a 300-second
 * signed link, made with the member's own token, so the database decides who may listen. The page's
 * `<audio preload="none">` points here, so nothing is fetched until the member presses play.
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const session = locals.session;
  if (!session) return plain('Sign in to listen to interviews.', 401);
  const id = String(params.id ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return plain('Not found', 404);
  try {
    const url = await signMemberInterviewAudio(resolveSupabaseEnv(locals), session.accessToken, id);
    if (!url) return plain('Not found', 404);
    return new Response(null, {
      status: 302,
      headers: { Location: url, 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    // The status only: an error's text may echo the request.
    const status = err instanceof Error ? Number(/\b(\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
    console.error('interview audio sign failed', status);
    return plain('Couldn’t load that interview right now.', 502);
  }
};

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}
