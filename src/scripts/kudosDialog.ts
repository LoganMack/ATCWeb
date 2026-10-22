// Share Kudos dialog, delegated and bound once like reportIncidentDialog.ts; imported by the Kudos shell
// because the dialog renders in a fetched fragment. Submit stays disabled until Session, Lap, Turn and a car
// are set (the server re-checks).
function updateKudosSubmit(form: HTMLFormElement) {
  const val = (name: string) =>
    (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
  const anyCar = form.querySelector('input[name="involved_driver_ids"]:checked') !== null;
  const submit = form.querySelector<HTMLButtonElement>('[data-kudos-submit]');
  if (submit) submit.disabled = !(val('session') && val('lap') !== '' && val('turn') && anyCar);
}

// Module-scoped, not a flag on document.body: the client router swaps <body>
// on every navigation, which would re-add these document listeners each time
// (see expandRows.ts's header).
let initialized = false;
function initKudosDialog() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-open-kudos-dialog]')) {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[data-kudos-dialog]');
      if (dialog && !dialog.open) {
        const form = dialog.querySelector<HTMLFormElement>('[data-kudos-form]');
        form?.reset();
        // Clear any leftover driver search and re-filter (driverPickerSearch.ts).
        const search = form?.querySelector<HTMLInputElement>('[data-driver-search]');
        if (search) {
          search.value = '';
          search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (form) updateKudosSubmit(form);
        dialog.showModal();
      }
      return;
    }
    if (target.closest('[data-close-kudos-dialog]')) {
      target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop (the <dialog> itself, outside its form) closes it.
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-kudos-dialog')) target.close();
  });
  const onFormChange = (e: Event) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-kudos-form]');
    if (form) updateKudosSubmit(form);
  };
  document.addEventListener('input', onFormChange);
  document.addEventListener('change', onFormChange);
}
initKudosDialog();
document.addEventListener('astro:page-load', initKudosDialog);
