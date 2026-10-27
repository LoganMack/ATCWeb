// The driver profile's kudos dialog (driver-profile-polish FR6.2, FR6.3): delegated and bound once, because
// the button and dialog arrive in a fetched fragment whose scripts never run. Imported by drivers/[id].astro.
// The native <dialog> closes on Escape by itself; every close returns focus to the kudos button.

const OPEN = '[data-open-driver-kudos]';
const CLOSE = '[data-close-driver-kudos]';
const DIALOG = 'dialog[data-driver-kudos-dialog]';

/** The dialog that belongs to this button: the fragment renders them side by side. */
export function dialogFor(button: Element): HTMLDialogElement | null {
  return button.parentElement?.querySelector<HTMLDialogElement>(DIALOG) ?? null;
}

/** Opens the dialog and remembers to hand focus back to the button when it closes, however it closes. */
export function openKudosDialog(button: HTMLElement): void {
  const dialog = dialogFor(button);
  if (!dialog || dialog.open) return;
  dialog.addEventListener('close', () => button.focus(), { once: true });
  dialog.showModal();
}

/** Click handling: the button opens, the close button or a click on the backdrop (the dialog itself) closes. */
export function onDocumentClick(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;
  const open = target.closest<HTMLElement>(OPEN);
  if (open) {
    openKudosDialog(open);
    return;
  }
  if (target.closest(CLOSE)) {
    target.closest<HTMLDialogElement>(DIALOG)?.close();
    return;
  }
  if (target.matches(DIALOG)) (target as HTMLDialogElement).close();
}

// Module-scoped, not a flag on document.body: the client router swaps <body> on every navigation.
let initialized = false;
export function initDriverKudos(doc: Document = document): void {
  if (initialized) return;
  initialized = true;
  doc.addEventListener('click', onDocumentClick);
}

if (typeof document !== 'undefined') initDriverKudos();
