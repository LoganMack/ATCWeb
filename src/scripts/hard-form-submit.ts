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
 * On the non-redirect (same-page re-render) path below, document.write()
 * swaps in the server's fresh HTML but does NOT give us a real navigation —
 * it reuses this same window/JS realm rather than loading a new one. That
 * matters because every `<script type="module">` on the page (this file
 * included, plus reveal.ts, pageProgress.ts, sortable-table.ts, and every
 * per-page init script) is already in this realm's module registry from the
 * real initial page load, so the identical <script> tags in the newly
 * written HTML do NOT re-execute — browsers only ever run a given module
 * specifier's top-level code once per realm. Concretely, that means
 * `astro:page-load` — which those modules only ever dispatch/listen for
 * from their own top-level code — never fires again on its own, so nothing
 * that depends on it re-initializes: reveal.ts never adds `.is-visible` to
 * the freshly-rendered `.reveal` elements (which is why an inline error or
 * "Saved." banner can render correctly in the DOM yet stay invisible at
 * opacity:0 forever, looking exactly like the save silently did nothing),
 * forms on the new page never get re-bound for their own next submit, and
 * every other astro:page-load-driven script (sortable tables, search
 * filters, local time formatting, etc.) goes stale. The event listeners
 * those modules registered on `document` earlier DO survive document.write
 * (open()/write()/close() resets the Document's content, not its existing
 * listeners), so manually re-dispatching the event below reaches all of
 * them and re-runs their init logic against the new DOM — the same effect
 * a real navigation would have had.
 */

import { showProgress, hideProgress } from './pageProgress';

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
      document.open();
      document.write(html);
      document.close();
      // See the top-of-file comment — without this, the just-written page
      // (including any error/"Saved." banner) never becomes visible and
      // nothing else that depends on astro:page-load re-initializes.
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
