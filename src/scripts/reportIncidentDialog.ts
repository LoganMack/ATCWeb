// Report Incident dialog, delegated and bound once; imported by the results shell because the dialog renders
// in a fetched fragment. Submit stays disabled until Session, Lap, Turn, Description and a car are set (the
// server re-checks).
function updateReportSubmit(form: HTMLFormElement) {
  const val = (name: string) =>
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
  const anyCar = form.querySelector('input[name="involved_driver_ids"]:checked') !== null;
  const submit = form.querySelector<HTMLButtonElement>('[data-report-submit]');
  if (submit)
    submit.disabled = !(val('session') && val('lap') !== '' && val('turn') && val('description') && anyCar);
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
// The homepage's "Submit Incident Report" link arrives as ?submit=incident: open the dialog once the fragment
// is in, then drop the param so a refresh doesn't reopen it.
function openDialogFromLink() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('submit') !== 'incident') return;
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-report-dialog]');
  if (!dialog) return;
  url.searchParams.delete('submit');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (dialog.open) return;
  const form = dialog.querySelector<HTMLFormElement>('[data-report-form]');
  form?.reset();
  if (form) updateReportSubmit(form);
  dialog.showModal();
}

initReportDialog();
document.addEventListener('astro:page-load', () => {
  initReportDialog();
  openDialogFromLink();
});
