/**
 * Makes every POST <form> behave like a real, full browser submission
 * instead of letting Astro's <ViewTransitions /> client router intercept
 * it (fetch + DOM-swap). That router was the actual cause of "login
 * silently fails and reloads" and, by extension, every other mutating
 * admin form: the server-side work (sign-in, saving a record, etc.)
 * succeeds and a redirect is sent back, but the router's swap only updates
 * part of the page instead of doing a real navigation — so a session
 * cookie set on that redirect response never visibly takes effect, and it
 * looks like nothing happened. Adding `data-astro-reload` to these forms
 * was the documented way to opt out, but didn't reliably stop it here, so
 * this takes a more direct approach.
 *
 * The listener is attached directly on each <form>, not via a
 * document-level delegated listener — that means it runs in the event's
 * target phase, before Astro's own delegated listener on `document` (which
 * runs during the bubble phase and, like any well-behaved global handler,
 * backs off once `event.defaultPrevented` is true). Calling
 * `preventDefault()` here wins regardless of Astro's exact interception
 * behavior in a given version, so this doesn't depend on
 * `data-astro-reload` doing anything at all.
 *
 * Because this fetch() happens entirely outside Astro's router, neither of
 * the router lifecycle events pageProgress.ts listens for ever fires for
 * it — so this calls showProgress()/hideProgress() itself around the
 * request. The submitter button also gets its own inline "submitting..."
 * label swap, since it's the one element the person actually clicked and
 * deserves more direct feedback than the page-wide bar alone.
 *
 * On the non-redirect (same-page re-render) path below, the server's fresh
 * HTML has to get onto the page WITHOUT a real navigation. The obvious way —
 * document.open()/write()/close() — turns out to be actively wrong here,
 * confirmed by testing directly against the deployed site rather than just
 * in a synthetic harness: it doesn't just reset the Document's content, it
 * also strips every event listener already registered on `document`
 * (verified live — a listener attached before the write, still reachable by
 * a plain property read afterward, no longer fires no matter how it's
 * re-dispatched to). That's fatal here because astro:page-load listeners
 * are exactly what reveal.ts, this file's own form-(re)binding, and every
 * other per-page init script register on `document` — once document.write
 * wipes them, nothing is left to react no matter how many times the event
 * gets redispatched afterward. (An earlier version of this fix tried
 * exactly that — redispatching post-write — and it looked right in an
 * isolated test page, but never actually worked in production for the same
 * reason: there was nothing listening anymore by the time it fired.)
 *
 * Also, separately: every `<script type="module">` on the page is already
 * in this realm's module registry from the real initial page load, so even
 * on a rewrite that DID preserve listeners, the identical <script> tags in
 * the fresh HTML wouldn't re-execute their top-level code — browsers only
 * ever run a given module specifier's top-level code once per realm. So
 * astro:page-load has to be redispatched manually either way; the fix below
 * is what makes sure there's still someone listening when it is.
 *
 * The actual fix: parse the response as a Document via DOMParser and copy
 * its title/head/body content across with plain DOM mutation (innerHTML
 * assignment), never touching document.open(). This is ordinary DOM
 * mutation, not a document-navigation primitive, so it does not touch
 * existing listeners — confirmed the same way, directly against the
 * deployed site. <script> tags inside the copied HTML stay inert (a
 * standard innerHTML safety behavior), which is fine — they're the same
 * already-loaded modules and were never going to re-run anyway. What
 * matters is that reveal.ts's `.is-visible` pass, this file's own
 * re-binding of the new page's forms, and everything else driven by
 * astro:page-load all still have live listeners to reach.
 */

import { showProgress, hideProgress } from './pageProgress';

/**
 * Replaces the current document's visible content with a freshly-fetched
 * page's HTML, in place, without ever calling document.open() — see the
 * top-of-file comment for why that distinction is what makes this work.
 */
function swapDocument(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.title = parsed.title;
  for (const attr of Array.from(document.documentElement.attributes)) {
    document.documentElement.removeAttribute(attr.name);
  }
  for (const attr of Array.from(parsed.documentElement.attributes)) {
    document.documentElement.setAttribute(attr.name, attr.value);
  }
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

function bindForm(form: HTMLFormElement) {
  if (form.dataset.hardSubmitBound === 'true') return;
  form.dataset.hardSubmitBound = 'true';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const formData = submitter ? new FormData(form, submitter) : new FormData(form);
    const buttons = form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
    buttons.forEach((btn) => (btn.disabled = true));

    const originalLabel = submitter?.textContent ?? null;
    if (submitter) submitter.textContent = 'Working…';

    showProgress();

    try {
      const res = await fetch(form.action, { method: 'POST', body: formData });

      if (res.redirected) {
        // Success path — do a real navigation to the real destination, so
        // any cookies set along the way (e.g. the session cookie on
        // login) are actually in effect for it. Leave the bar showing;
        // the destination page's own load will clear it.
        window.location.assign(res.url);
        return;
      }

      // No redirect means the server re-rendered this same page in
      // place — almost always to show a validation/auth error. Render
      // that HTML directly rather than reloading the URL, which would be
      // a fresh GET that can't reproduce whatever the POST determined.
      const html = await res.text();
      hideProgress();
      swapDocument(html);
      // See the top-of-file comment — without this, the just-swapped-in
      // page (including any error/"Saved." banner) never becomes visible
      // and nothing else that depends on astro:page-load re-initializes.
      document.dispatchEvent(new Event('astro:page-load'));
    } catch (err) {
      console.error('Form submission failed:', err);
      hideProgress();
      buttons.forEach((btn) => (btn.disabled = false));
      if (submitter && originalLabel !== null) submitter.textContent = originalLabel;
      alert('Could not reach the server — check your connection and try again.');
    }
  });
}

function initHardFormSubmit() {
  document.querySelectorAll<HTMLFormElement>('form[method="POST" i]').forEach(bindForm);
}

document.addEventListener('astro:page-load', initHardFormSubmit);
