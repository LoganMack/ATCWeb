/**
 * Admin → Incident Reporting: turning Posted back on for a round that was posted before asks first whether to
 * reset the post date (restarting the reporting and appeal windows) or keep the original one (BR1.1). The
 * choice goes in the form's hidden `date` field; Cancel sends nothing, so the switch stays off. Without this
 * script the form posts with `date=reset`, the same as before.
 */

/** The form waiting on the popup's answer. */
let pending: HTMLFormElement | null = null;

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('[data-repost-dialog]');
}

function bindOnce() {
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as Element | null;
      if (!(form instanceof HTMLFormElement) || !form.matches('[data-post-switch][data-first-posted]'))
        return;
      // The popup's own answer re-submits the form: let that one through.
      if (form.dataset.repostAnswered === 'true') {
        delete form.dataset.repostAnswered;
        return;
      }
      const popup = dialog();
      if (!popup) return;
      event.preventDefault();
      pending = form;
      popup.showModal();
    },
    true,
  );

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target?.closest) return;
    const popup = dialog();
    if (!popup || !popup.contains(target)) return;

    const choiceBtn = target.closest<HTMLButtonElement>('[data-repost-choice]');
    if (choiceBtn && pending) {
      const form = pending;
      pending = null;
      const field = form.querySelector<HTMLInputElement>('[data-post-date-choice]');
      if (field) field.value = choiceBtn.dataset.repostChoice === 'keep' ? 'keep' : 'reset';
      form.dataset.repostAnswered = 'true';
      popup.close();
      form.requestSubmit();
      return;
    }
    if (target.closest('[data-repost-cancel]') || target === popup) popup.close();
  });

  // However the popup closes without an answer (Cancel, Esc, backdrop), nothing is sent and the switch stays
  // as it was.
  document.addEventListener(
    'close',
    (event) => {
      if (event.target === dialog() && pending) {
        const field = pending.querySelector<HTMLInputElement>('[data-post-date-choice]');
        if (field) field.value = 'reset';
        pending = null;
      }
    },
    true,
  );
}

if (typeof document !== 'undefined') bindOnce();
