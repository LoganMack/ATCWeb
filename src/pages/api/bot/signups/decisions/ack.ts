import type { APIRoute } from 'astro';
import { resolveBotApiEnv, isAuthorizedBot, serviceRpc, json } from '../../../../../lib/signups';

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/bot/signups/decisions/ack — the bot confirms which rejections it
 * has DM'd. Body (JSON): { request_ids: [uuid, ...] }. Response: { acknowledged: N }.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = resolveBotApiEnv(locals);
  if (!(await isAuthorizedBot(request, env.botToken))) return json({ error: 'unauthorized' }, 401);

  let ids: unknown;
  try {
    ids = ((await request.json()) as { request_ids?: unknown }).request_ids;
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === 'string' && UUID.test(id))) {
    return json({ error: 'request_ids must be a list of 1-100 request IDs' }, 400);
  }

  try {
    const acknowledged = await serviceRpc<number>(env, 'ack_signup_rejections', { p_request_ids: ids });
    return json({ acknowledged });
  } catch (err) {
    console.error('Bot sign-up acknowledgement failed:', err);
    return json({ error: 'Could not record the acknowledgement' }, 500);
  }
};
