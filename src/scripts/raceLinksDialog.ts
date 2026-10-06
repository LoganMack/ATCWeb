// Race Links dialog behavior (open/close, backdrop click) — a delegated, register-once listener.
// Imported by src/pages/results/[subsessionId].astro (the shell), because RaceLinksBlock
// itself now renders inside a fetched fragment where <script> tags never execute.
// One delegated listener (registered once) so it keeps working across
// client-side navigations without re-binding.
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
initRaceLinksDialog();
document.addEventListener('astro:page-load', initRaceLinksDialog);
