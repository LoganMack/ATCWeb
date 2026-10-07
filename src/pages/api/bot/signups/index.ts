import type { APIRoute } from 'astro';
import {
  resolveBotApiEnv,
  isAuthorizedBot,
  serviceRpc,
  json,
  SignupInputError,
  type SubmitSignupResult,
} from '../../../../lib/signups';

export const prerender = false;

/**
 * POST /api/bot/signups — the Discord bot's /atcsignup submits here
 * (docs/signup-integration.md). Body (JSON):
 *   { discord_user_id, discord_username?, name, numbers: [n, ...], iracing_id? }
 * Answers 200 with submit_signup_request()'s result — { status: 'pending', ... }
 * or { status: 'all_taken', ... } — 400 for bad input, 401 without the bot token.
 *
 * Must be sent as application/json: astro.config's checkOrigin only lets
 * cross-origin POSTs through when they aren't form-encoded.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = resolveBotApiEnv(locals);
  if (!(await isAuthorizedBot(request, env.botToken))) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  // Shape checks only — the database function does the real validation.
  const numbers = Array.isArray(body.numbers) ? body.numbers.map((n) => Number(n)) : [];
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n))) {
    return json({ error: 'numbers must be a list of whole numbers' }, 400);
  }
  const iracingRaw = body.iracing_id;
  const iracingId = iracingRaw === undefined || iracingRaw === null || iracingRaw === '' ? null : Number(iracingRaw);
  if (iracingId !== null && !Number.isSafeInteger(iracingId)) {
    return json({ error: 'iracing_id must be a whole number' }, 400);
  }

  try {
    const result = await serviceRpc<SubmitSignupResult>(env, 'submit_signup_request', {
      p_discord_user_id: String(body.discord_user_id ?? ''),
      p_discord_username: typeof body.discord_username === 'string' ? body.discord_username : null,
      p_name: typeof body.name === 'string' ? body.name : '',
      p_numbers: numbers,
      p_iracing_cust_id: iracingId,
    });
    return json(result);
  } catch (err) {
    if (err instanceof SignupInputError) return json({ error: err.message }, 400);
    console.error('Bot sign-up submission failed:', err);
    return json({ error: 'Could not save the sign-up' }, 500);
  }
};
