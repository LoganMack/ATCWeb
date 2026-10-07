import type { APIRoute } from 'astro';
import { resolveBotApiEnv, isAuthorizedBot, serviceRpc, json, type PendingRejection } from '../../../../../lib/signups';

export const prerender = false;

/**
 * GET /api/bot/signups/decisions — rejected sign-ups the bot hasn't DM'd yet
 * (docs/signup-integration.md). The bot polls this, DMs each driver the
 * reason, then confirms with POST ./ack so nobody is DM'd twice.
 * Response: { rejections: [{ request_id, discord_user_id, name, reason }] }
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = resolveBotApiEnv(locals);
  if (!(await isAuthorizedBot(request, env.botToken))) return json({ error: 'unauthorized' }, 401);

  try {
    const rejections = await serviceRpc<PendingRejection[]>(env, 'pending_signup_rejections', {});
    return json({ rejections });
  } catch (err) {
    console.error('Bot sign-up decisions lookup failed:', err);
    return json({ error: 'Could not load decisions' }, 500);
  }
};
