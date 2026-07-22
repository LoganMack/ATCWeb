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
 */

function bindForm(form: HTMLFormElement) {
  if (form.dataset.hardSubmitBound === 'true') return;
  form.dataset.hardSubmitBound = 'true';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const formData = submitter ? new FormData(form, submitter) : new FormData(form);
    const buttons = form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
    buttons.forEach((btn) => (btn.disabled = true));

    try {
      const res = await fetch(form.action, { method: 'POST', body: formData });

      if (res.redirected) {
        // Success path — do a real navigation to the real destination, so
        // any cookies set along the way (e.g. the session cookie on
        // login) are actually in effect for it.
        window.location.assign(res.url);
        return;
      }

      // No redirect means the server re-rendered this same page in
      // place — almost always to show a validation/auth error. Render
      // that HTML directly rather than reloading the URL, which would be
      // a fresh GET that can't reproduce whatever the POST determined.
      const html = await res.text();
      document.open();
      document.write(html);
      document.close();
    } catch (err) {
      console.error('Form submission failed:', err);
      buttons.forEach((btn) => (btn.disabled = false));
      alert('Could not reach the server — check your connection and try again.');
    }
  });
}

function initHardFormSubmit() {
  document.querySelectorAll<HTMLFormElement>('form[method="POST" i]').forEach(bindForm);
}

document.addEventListener('astro:page-load', initHardFormSubmit);
