// Race Links dialog (open/close, backdrop), one delegated listener bound once. Imported by the results shell
// because RaceLinksBlock renders in a fetched fragment where scripts don't run.
function initRaceLinksDialog() {
  if (document.body.dataset.raceLinksInit === 'true') return;
  document.body.dataset.raceLinksInit = 'true';
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const opener = target.closest<HTMLElement>('[data-open-race-links]');
    if (opener) {
      const dialog = document.getElementById(opener.dataset.openRaceLinks ?? '');
      if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
      return;
    }
    if (target.closest('[data-close-race-links]')) {
      target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop (the <dialog> element itself, outside its content) closes it.
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-race-links-dialog')) target.close();
  });
}
// A refused save comes back with the dialog marked to reopen on its field error.
function openRaceLinksWithError() {
  const dialog = document.querySelector('dialog[data-race-links-autoopen]');
  if (dialog instanceof HTMLDialogElement && !dialog.open) {
    dialog.removeAttribute('data-race-links-autoopen');
    dialog.showModal();
  }
}

initRaceLinksDialog();
document.addEventListener('astro:page-load', () => {
  initRaceLinksDialog();
  openRaceLinksWithError();
});
