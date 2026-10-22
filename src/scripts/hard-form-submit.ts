/**
 * Makes every POST <form> a real submission instead of a View Transitions DOM swap, which hid cookies set on
 * the redirect (the login session). The listener sits on each form, so it beats Astro's document listener,
 * and drives the progress bar itself. Same-page re-renders are copied in with DOMParser + innerHTML, never
 * document.open()/write(), which strips `document`'s listeners; astro:page-load is then redispatched.
 */

import { showProgress, hideProgress } from './pageProgress';

/** Swaps in the fetched page's content without document.open(), which would drop the document's listeners. */
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
        // Navigate for real so cookies set on the way take effect; the next page clears the bar.
        window.location.assign(res.url);
        return;
      }

      // No redirect means the server re-rendered this page (usually an error); render that HTML, since
      // reloading would be a fresh GET.
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
