// Report Incident dialog behavior (open/close, submit enabling) — delegated, register-once listeners.
// Imported by src/pages/results/[subsessionId].astro (the shell), because the dialog markup
// now renders inside a fetched fragment where <script> tags never execute.
// One delegated listener set (registered once) so it survives client-side
// navigations; the submit button stays disabled until Session, Lap, Turn
// and at least one car are filled in (server re-checks all of it).
function updateReportSubmit(form: HTMLFormElement) {
  const val = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
  const anyCar = form.querySelector('input[name="involved_driver_ids"]:checked') !== null;
  const submit = form.querySelector<HTMLButtonElement>('[data-report-submit]');
  if (submit) submit.disabled = !(val('session') && val('lap') !== '' && val('turn') && anyCar);
}

function initReportDialog() {
  if (document.body.dataset.reportDialogInit === 'true') return;
  document.body.dataset.reportDialogInit = 'true';
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-open-report-dialog]')) {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[data-report-dialog]');
      if (dialog && !dialog.open) {
        const form = dialog.querySelector<HTMLFormElement>('[data-report-form]');
        form?.reset();
        if (form) updateReportSubmit(form);
        dialog.showModal();
      }
      return;
    }
    if (target.closest('[data-close-report-dialog]')) {
      target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop (the <dialog> itself, outside its form) closes it.
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-report-dialog')) target.close();
  });
  const onFormChange = (e: Event) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-report-form]');
    if (form) updateReportSubmit(form);
  };
  document.addEventListener('input', onFormChange);
  document.addEventListener('change', onFormChange);
}
initReportDialog();
document.addEventListener('astro:page-load', initReportDialog);
