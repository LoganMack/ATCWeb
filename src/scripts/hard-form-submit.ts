/**
 * Lets every POST <form> submit natively instead of through the View Transitions router: the browser posts,
 * follows the redirect once, applies the cookies set on it (the login session) and renders the next page
 * once. A re-rendered error page is an ordinary page load. This only opts each form out of the router and
 * drives the buttons and the progress bar.
 */

import { showProgress, hideProgress } from './pageProgress';

const WORKING_LABEL = 'Working…';

function submitButtons(form: HTMLFormElement) {
  return form.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
}

function markWorking(form: HTMLFormElement, submitter: HTMLElement | null) {
  submitButtons(form).forEach((btn) => (btn.disabled = true));
  if (submitter?.tagName === 'BUTTON') {
    submitter.dataset.hardSubmitLabel = submitter.textContent ?? '';
    submitter.textContent = WORKING_LABEL;
  }
  showProgress();
}

/** Undoes markWorking, for a page the browser restores from its back/forward cache mid-submit. */
function resetForm(form: HTMLFormElement) {
  delete form.dataset.hardSubmitInFlight;
  submitButtons(form).forEach((btn) => {
    btn.disabled = false;
    if (btn.dataset.hardSubmitLabel !== undefined) {
      btn.textContent = btn.dataset.hardSubmitLabel;
      delete btn.dataset.hardSubmitLabel;
    }
  });
  hideProgress();
}

export function bindForm(form: HTMLFormElement): void {
  if (form.dataset.hardSubmitBound === 'true') return;
  form.dataset.hardSubmitBound = 'true';
  // The router skips any form carrying data-astro-reload, so the browser submits it itself.
  form.dataset.astroReload = '';

  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    if (form.dataset.hardSubmitInFlight === 'true') {
      event.preventDefault();
      return;
    }
    form.dataset.hardSubmitInFlight = 'true';
    const submitter = (event as SubmitEvent).submitter;
    // Deferred because the browser builds the form data after this listener, and a disabled submitter would
    // drop its name and value from it. A later listener may also still cancel the submit.
    setTimeout(() => {
      if (event.defaultPrevented) {
        delete form.dataset.hardSubmitInFlight;
        return;
      }
      markWorking(form, submitter);
    }, 0);
  });
}

function initHardFormSubmit() {
  document.querySelectorAll<HTMLFormElement>('form[method="POST" i]').forEach(bindForm);
}

function onPageShow(event: PageTransitionEvent) {
  if (!event.persisted) return;
  document.querySelectorAll<HTMLFormElement>('form[data-hard-submit-in-flight]').forEach(resetForm);
}

document.addEventListener('astro:page-load', initHardFormSubmit);
window.addEventListener('pageshow', onPageShow);
