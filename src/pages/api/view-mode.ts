import type { APIRoute } from 'astro';
import { VIEW_MODE_COOKIE, authCookieOptions } from '../../lib/auth';

export const prerender = false;

/**
 * Toggles the "View as Visitor" preview cookie (see Footer.astro and
 * src/lib/auth.ts's isAdminView). Server-side enforces real-admin-only
 * even though the form itself is only ever rendered for one, same
 * defense-in-depth every other mutation in this codebase already does.
 */
export const POST: APIRoute = async ({ locals, cookies, request, redirect }) => {
  const form = await request.formData();
  const rawNext = String(form.get('next') ?? '/');
  // Only ever redirect back to a same-site relative path — a `next` value
  // from a form field is still user-controllable input, and an absolute
  // URL there would be an open redirect.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  if (locals.isRealAdmin) {
    const mode = String(form.get('mode') ?? '');
    if (mode === 'visitor') {
      cookies.set(VIEW_MODE_COOKIE, 'visitor', {
        ...authCookieOptions(new URL(request.url)),
        maxAge: 60 * 60 * 24 * 30,
      });
    } else {
      cookies.delete(VIEW_MODE_COOKIE, { path: '/' });
    }
  }

  return redirect(next, 302);
};
