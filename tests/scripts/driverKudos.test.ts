/**
 * The driver profile's kudos dialog script (driver-profile-polish FR6.2, FR6.3): the button opens its dialog,
 * the close button and a backdrop click close it, and every close (Escape included, which the native dialog
 * turns into a close event) returns focus to the button. The repo has no DOM library, so small stand-ins
 * play the elements.
 */
import { describe, expect, it, vi } from 'vitest';
import { onDocumentClick, openKudosDialog } from '../../src/scripts/driverKudos';

/** A stand-in <dialog>: showModal/close toggle `open`, and close fires the "close" listeners once. */
function fakeDialog() {
  const listeners: (() => void)[] = [];
  const dialog = {
    open: false,
    showModal: vi.fn(() => {
      dialog.open = true;
    }),
    close: vi.fn(() => {
      if (!dialog.open) return;
      dialog.open = false;
      listeners.splice(0).forEach((fn) => fn());
    }),
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    matches: (selector: string) => selector === 'dialog[data-driver-kudos-dialog]',
    closest: (selector: string) => (selector === 'dialog[data-driver-kudos-dialog]' ? dialog : null),
  };
  return dialog;
}

function setup() {
  const dialog = fakeDialog();
  const parent = { querySelector: () => dialog };
  const button = {
    parentElement: parent,
    focus: vi.fn(),
    closest: (selector: string) => (selector === '[data-open-driver-kudos]' ? button : null),
  };
  const closeButton = {
    closest: (selector: string) => {
      if (selector === '[data-close-driver-kudos]') return closeButton;
      if (selector === 'dialog[data-driver-kudos-dialog]') return dialog;
      return null;
    },
    matches: () => false,
  };
  const click = (target: unknown) => onDocumentClick({ target } as unknown as Event);
  return { dialog, button, closeButton, click };
}

describe('driver kudos dialog (FR6.2, FR6.3)', () => {
  it('opens on a button click', () => {
    const { dialog, button, click } = setup();
    click(button);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
  });

  it('closes from its close button and returns focus to the kudos button', () => {
    const { dialog, button, closeButton, click } = setup();
    click(button);
    click(closeButton);
    expect(dialog.open).toBe(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click (the dialog itself is the target)', () => {
    const { dialog, button, click } = setup();
    click(button);
    click(dialog);
    expect(dialog.open).toBe(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it('returns focus after Escape, which the browser turns into a close', () => {
    const { dialog, button } = setup();
    openKudosDialog(button as unknown as HTMLElement);
    dialog.close();
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it('does not reopen an open dialog, and ignores clicks elsewhere', () => {
    const { dialog, button, click } = setup();
    click(button);
    click(button);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    click({ closest: () => null, matches: () => false });
    expect(dialog.open).toBe(true);
  });
});
