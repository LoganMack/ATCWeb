import type { APIRoute } from 'astro';
import { BROADCASTER_COOKIE, authCookieOptions } from '../../lib/auth';

import { safeNext } from '../../lib/security';

export const prerender = false;

/**
 * Toggles "View as Broadcaster" (see Footer.astro, src/lib/auth.ts's
 * BROADCASTER_COOKIE, and src/middleware.ts): while on, every statistic on
 * the site reads as though the most recent round didn't exist, so a
 * broadcaster recording a delayed broadcast never has spoilers baked in.
 * Open to everyone — it only changes what THIS browser sees.
 */
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const form = await request.formData();
  const rawNext = String(form.get('next') ?? '/');
  // Same-site relative paths only — `next` is user-controllable input.
  const next = safeNext(rawNext, '/');

  if (String(form.get('mode') ?? '') === 'on') {
    cookies.set(BROADCASTER_COOKIE, '1', {
      ...authCookieOptions(new URL(request.url)),
      maxAge: 60 * 60 * 24 * 30,
    });
  } else {
    cookies.delete(BROADCASTER_COOKIE, { path: '/' });
  }

  return redirect(next, 302);
};
