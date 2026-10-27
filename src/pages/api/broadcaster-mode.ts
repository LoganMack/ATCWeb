import type { APIRoute } from 'astro';
import { BROADCASTER_COOKIE, authCookieOptions, isBroadcasterAccount } from '../../lib/auth';

import { safeNext } from '../../lib/security';

export const prerender = false;

/**
 * Toggles "View as Broadcaster": the site reads as if the latest round hadn't run, so a delayed broadcast has
 * no spoilers. Only the signed-in Broadcaster may turn it on (BR1.8); for anyone else the cookie is cleared.
 */
export const POST: APIRoute = async ({ cookies, locals, request, redirect }) => {
  const form = await request.formData();
  const rawNext = String(form.get('next') ?? '/');
  // Same-site relative paths only — `next` is user-controllable input.
  const next = safeNext(rawNext, '/');

  if (isBroadcasterAccount(locals) && String(form.get('mode') ?? '') === 'on') {
    cookies.set(BROADCASTER_COOKIE, '1', {
      ...authCookieOptions(new URL(request.url)),
      maxAge: 60 * 60 * 24 * 30,
    });
  } else {
    cookies.delete(BROADCASTER_COOKIE, { path: '/' });
  }

  return redirect(next, 302);
};
