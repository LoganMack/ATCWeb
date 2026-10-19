// Behaviour that used to live in inline on*= attributes, which the strict
// script CSP blocks. Listeners sit on document (registered once) so they also
// cover markup injected later by the shell-then-fragment pages.
//
//   <select data-navigate-on-change>            go to the selected option's value
//   <select data-navigate-on-change="/x?y=">    go to that prefix + the encoded value
//   <select data-submit-on-change>              submit the select's form
//   <select data-submit-on-change data-disable-on-submit="round">
//                                               also disable that form field first
//   <form data-confirm="Delete this?">          ask before submitting

function onChange(e: Event): void {
  const control = e.target;
  if (!(control instanceof HTMLSelectElement || control instanceof HTMLInputElement)) return;

  if (control.hasAttribute('data-navigate-on-change')) {
    const prefix = control.getAttribute('data-navigate-on-change') ?? '';
    window.location.href = prefix ? prefix + encodeURIComponent(control.value) : control.value;
    return;
  }

  if (control.hasAttribute('data-submit-on-change') && control.form) {
    const disableName = control.dataset.disableOnSubmit;
    if (disableName) {
      const field = control.form.elements.namedItem(disableName);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.disabled = true;
    }
    // form.submit() (not requestSubmit) so no submit handlers run, as the old inline handler did.
    control.form.submit();
  }
}

function onSubmit(e: SubmitEvent): void {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  const message = form.dataset.confirm;
  if (message && !window.confirm(message)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

function initDelegatedControls(): void {
  if (document.documentElement.dataset.delegatedControlsInit === 'true') return;
  document.documentElement.dataset.delegatedControlsInit = 'true';
  document.addEventListener('change', onChange);
  // Capture phase, so a cancelled confirm stops the submit before any other listener sees it.
  document.addEventListener('submit', onSubmit, true);
}

initDelegatedControls();
