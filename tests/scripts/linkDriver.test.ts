/**
 * The Link Driver page's script (U2 driver-linking, BR3.4; broadcaster-staff-roles C6): the search by name and
 * by leading car-number digits, the Broadcaster row that every search keeps, the confirm dialog's two modes,
 * the live car-number hint (BR5.2) and the New Driver Sign-Up popup's open, close and reopen-on-error (W5).
 * The tests have no DOM, so the popup functions get a stand-in dialog; the delegated wiring is not loaded in Node.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  closeSignupDialog,
  confirmDialogCopy,
  filterDrivers,
  matchesDriver,
  numberStatusView,
  openSignupDialog,
  openSignupOnLoad,
  parseTakenNumbers,
  rowShown,
  type DialogLike,
  type FilterableDriver,
} from '../../src/scripts/linkDriver';

const roster: FilterableDriver[] = [
  { name: 'Amy Brown', number: '12' },
  { name: 'Bea Browning', number: '7' },
  { name: 'Carl 123', number: '' },
  { name: 'Dan Driver', number: '120' },
];
const names = (list: FilterableDriver[]) => list.map((d) => d.name);

/** A stand-in <dialog> whose showModal/close flip `open`, with an optional name field to focus. */
function fakeDialog(dataset: Record<string, string> = {}, open = false) {
  const nameField = { focus: vi.fn() };
  const dialog = {
    open,
    dataset,
    showModal: vi.fn(() => {
      dialog.open = true;
    }),
    close: vi.fn(() => {
      dialog.open = false;
    }),
    querySelector: vi.fn((selector: string) => (selector === 'input[name="name"]' ? nameField : null)),
  };
  return { dialog: dialog as unknown as DialogLike & typeof dialog, nameField };
}

describe('filterDrivers', () => {
  it('matches part of a name, ignoring case and surrounding spaces', () => {
    expect(names(filterDrivers(roster, '  BROW '))).toEqual(['Amy Brown', 'Bea Browning']);
  });

  it('matches car numbers by their leading digits', () => {
    expect(names(filterDrivers(roster, '12'))).toEqual(['Amy Brown', 'Carl 123', 'Dan Driver']);
    expect(names(filterDrivers(roster, '7'))).toEqual(['Bea Browning']);
    // "2" is inside 12 and 120 but starts neither, and is in no name.
    expect(names(filterDrivers(roster, '2'))).toEqual(['Carl 123']);
  });

  it('returns every driver for an empty query and none when nothing matches', () => {
    expect(filterDrivers(roster, '   ')).toHaveLength(roster.length);
    expect(filterDrivers(roster, 'xyz')).toEqual([]);
    expect(filterDrivers([], 'amy')).toEqual([]);
  });

  it('never matches a number for a driver without one', () => {
    expect(matchesDriver({ name: 'No Number', number: '' }, '1')).toBe(false);
  });
});

describe('rowShown', () => {
  it('keeps the Broadcaster row whatever the search', () => {
    const broadcaster = { alwaysShown: true, name: '', number: '' };
    expect(rowShown(broadcaster, 'zzz')).toBe(true);
    expect(rowShown(broadcaster, '42')).toBe(true);
    expect(rowShown(broadcaster, '')).toBe(true);
  });

  it('filters driver rows as before', () => {
    expect(rowShown({ alwaysShown: false, name: 'Amy Brown', number: '12' }, 'amy')).toBe(true);
    expect(rowShown({ alwaysShown: false, name: 'Amy Brown', number: '12' }, 'zzz')).toBe(false);
  });
});

describe('confirmDialogCopy', () => {
  it('asks to link a driver, naming the number', () => {
    expect(confirmDialogCopy({ broadcaster: false, name: 'Amy Brown', number: '12' })).toEqual({
      intent: 'link-driver',
      title: 'Link to Amy Brown (#12)?',
      confirmLabel: 'Link Driver',
    });
    expect(confirmDialogCopy({ broadcaster: false, name: 'Carl', number: '' }).title).toBe('Link to Carl?');
  });

  it('asks to become the Broadcaster and posts the claim', () => {
    expect(confirmDialogCopy({ broadcaster: true, name: '', number: '' })).toEqual({
      intent: 'claim-broadcaster',
      title: 'Become the Broadcaster?',
      confirmLabel: 'Become Broadcaster',
    });
  });
});

describe('the car-number hint', () => {
  it('reads "#n is available" or "#n is taken" with the status colour', () => {
    expect(numberStatusView('55', [7, 12])).toEqual({
      text: '#55 is available',
      className: 'text-brand-primary',
    });
    expect(numberStatusView('12', [7, 12])).toEqual({ text: '#12 is taken', className: 'text-brand-pink' });
  });

  it('says nothing until the field holds a number 0-999', () => {
    expect(numberStatusView('', [7])).toBeNull();
    expect(numberStatusView('1234', [7])).toBeNull();
  });

  it('reads the JSON island defensively', () => {
    expect(parseTakenNumbers('[7,12,"x",3.5]')).toEqual([7, 12]);
    expect(parseTakenNumbers('not json')).toEqual([]);
    expect(parseTakenNumbers(null)).toEqual([]);
    expect(parseTakenNumbers('{"a":1}')).toEqual([]);
  });
});

describe('the New Driver Sign-Up popup', () => {
  it('opens as a modal with the name field focused, and closes again', () => {
    const { dialog, nameField } = fakeDialog();
    openSignupDialog(dialog);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
    expect(nameField.focus).toHaveBeenCalled();
    closeSignupDialog(dialog);
    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  it('does not open twice or close a closed popup', () => {
    const { dialog } = fakeDialog({}, true);
    openSignupDialog(dialog);
    expect(dialog.showModal).not.toHaveBeenCalled();
    dialog.open = false;
    closeSignupDialog(dialog);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it('opens on load only when the page carries a sign-up error', () => {
    const withError = fakeDialog({ openOnLoad: 'true' });
    expect(openSignupOnLoad(withError.dialog)).toBe(true);
    expect(withError.dialog.showModal).toHaveBeenCalledTimes(1);
    // A second page-load event finds it open already.
    expect(openSignupOnLoad(withError.dialog)).toBe(false);
    const noError = fakeDialog({});
    expect(openSignupOnLoad(noError.dialog)).toBe(false);
    expect(noError.dialog.showModal).not.toHaveBeenCalled();
    expect(openSignupOnLoad(null)).toBe(false);
  });
});
