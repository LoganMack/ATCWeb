/**
 * The POST form submit listener (U5: BR5.1, BR5.3). Vitest runs in node, so the form, its buttons and the
 * submit event are small fakes, and the page-level listeners the module registers go to stubbed globals.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { showProgress } from '../../src/scripts/pageProgress';

vi.mock('../../src/scripts/pageProgress', () => ({ showProgress: vi.fn(), hideProgress: vi.fn() }));

type BindForm = (form: HTMLFormElement) => void;
let bindForm: BindForm;

interface FakeButton {
  tagName: string;
  disabled: boolean;
  textContent: string;
  dataset: Record<string, string>;
}

interface FakeEvent {
  defaultPrevented: boolean;
  submitter: FakeButton | null;
  preventDefault: ReturnType<typeof vi.fn>;
}

function button(label: string): FakeButton {
  return { tagName: 'BUTTON', disabled: false, textContent: label, dataset: {} };
}

/** A POST form with Save and Delete submit buttons; `submit` fires its listeners like the browser does. */
function fakeForm() {
  const listeners: ((event: FakeEvent) => void)[] = [];
  const buttons = [button('Save'), button('Delete')];
  const dataset: Record<string, string> = {};
  const form = {
    dataset,
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => {
      if (type === 'submit') listeners.push(fn);
    },
    querySelectorAll: () => buttons,
  };
  const submit = (submitter: FakeButton | null = buttons[0]) => {
    const event: FakeEvent = {
      defaultPrevented: false,
      submitter,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true;
      }),
    };
    listeners.forEach((fn) => fn(event));
    return event;
  };
  return { form: form as unknown as HTMLFormElement, buttons, dataset, listeners, submit };
}

beforeAll(async () => {
  vi.stubGlobal('document', { addEventListener: vi.fn(), querySelectorAll: () => [] });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  ({ bindForm } = await import('../../src/scripts/hard-form-submit'));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(showProgress).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hard-form-submit bindForm', () => {
  it('opts a POST form out of the client router, once', () => {
    const { form, dataset, listeners } = fakeForm();
    bindForm(form);
    bindForm(form);
    expect(dataset.astroReload).toBe('');
    expect(dataset.hardSubmitBound).toBe('true');
    expect(listeners).toHaveLength(1);
  });

  it('lets the browser submit natively: preventDefault is never called', () => {
    const { form, submit } = fakeForm();
    bindForm(form);
    const event = submit();
    vi.runAllTimers();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('disables the buttons, shows "Working…" and the progress bar after the form data is taken', () => {
    const { form, buttons, submit } = fakeForm();
    bindForm(form);
    submit(buttons[0]);
    // Still enabled while the browser builds the form data, so the submitter's name and value are sent.
    expect(buttons.map((b) => b.disabled)).toEqual([false, false]);
    vi.runAllTimers();
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons[0].textContent).toBe('Working…');
    expect(buttons[1].textContent).toBe('Delete');
    expect(showProgress).toHaveBeenCalledTimes(1);
  });

  it('cancels a second submit while the first is in flight', () => {
    const { form, submit } = fakeForm();
    bindForm(form);
    const first = submit();
    const second = submit();
    vi.runAllTimers();
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(showProgress).toHaveBeenCalledTimes(1);
  });

  it('does nothing when another listener cancels the submit, so a later submit still works', () => {
    const { form, buttons, dataset, submit } = fakeForm();
    bindForm(form);
    const cancelled = submit();
    cancelled.preventDefault(); // e.g. a confirm() the person declined, in a later listener
    vi.runAllTimers();
    expect(buttons.map((b) => b.disabled)).toEqual([false, false]);
    expect(dataset.hardSubmitInFlight).toBeUndefined();
    expect(showProgress).not.toHaveBeenCalled();

    const retry = submit();
    vi.runAllTimers();
    expect(retry.preventDefault).not.toHaveBeenCalled();
    expect(buttons[0].disabled).toBe(true);
  });
});
