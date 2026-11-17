/**
 * Edit Results' icon buttons (results-quick-fixes FR1, FR2): the pencil turns into tick and cross in edit mode,
 * the counts hide behind their inputs, Escape puts everything back, and the column hides when it has no room
 * beside the table. Vitest runs in node, so the page is a set of small fakes behind stubbed globals.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { key?: string; target?: unknown; preventDefault: () => void }) => void;

class FakeElement {
  classes: Set<string>;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  offsetWidth = 0;
  parentElement: FakeElement | null = null;
  children = new Map<string, FakeElement>();
  right = 0;
  focus = vi.fn();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };

  constructor(classes = '') {
    this.classes = new Set(classes.split(' ').filter(Boolean));
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  querySelector(selector: string) {
    return this.children.get(selector) ?? null;
  }

  row: FakeElement | null = null;
  marks: FakeElement[] = [];

  closest(selector: string) {
    return selector === 'tr' ? this.row : null;
  }

  querySelectorAll(selector: string) {
    return selector === '[data-incidents-adjusted]' ? this.marks : [];
  }

  getBoundingClientRect() {
    return { right: this.right };
  }
}

const listeners = new Map<string, Listener[]>();
const page = {
  form: null as unknown as FakeElement,
  inputs: [] as FakeElement[],
  error: null as unknown as FakeElement,
  viewportWidth: 1280,
  wide: true,
};

let setEditing: (form: HTMLFormElement, editing: boolean) => void;
let placeEditControls: (form: HTMLFormElement) => void;
let hasRoomBeside: (tableRight: number, viewportWidth: number, columnWidth: number) => boolean;

/** The fragment's markup for Edit Results: the column, its two buttons, and two rows' count and input. */
function buildPage() {
  const anchor = new FakeElement('relative');
  anchor.right = 1000;
  const form = new FakeElement('absolute left-full top-0 ml-2 hidden flex-col gap-2');
  form.attrs.set('id', 'edit-incidents-form');
  (form as unknown as { id: string }).id = 'edit-incidents-form';
  form.parentElement = anchor;
  form.offsetWidth = 40;
  const toggle = new FakeElement('btn btn-neutral btn-sm');
  toggle.children.set('[data-icon="edit"]', new FakeElement('h-4 w-4'));
  toggle.children.set('[data-icon="save"]', new FakeElement('hidden h-4 w-4'));
  const cancel = new FakeElement('btn btn-neutral btn-sm hidden');
  form.children.set('[data-edit-incidents-toggle]', toggle);
  form.children.set('[data-edit-incidents-cancel]', cancel);

  page.inputs = ['3', '0'].map((current, i) => {
    const cell = new FakeElement();
    const display = new FakeElement('inline-block');
    cell.children.set('[data-incidents-display]', display);
    const input = new FakeElement();
    input.hidden = true;
    input.value = current;
    input.dataset = { current, driverName: `Driver ${i + 1}` };
    input.parentElement = cell;
    // The first row's count was changed by an admin, so it carries the adjustment asterisk.
    input.row = new FakeElement();
    if (i === 0) input.row.marks = [new FakeElement('cursor-help')];
    return input;
  });
  page.form = form;
  page.error = new FakeElement();
  page.error.hidden = true;
}

const toggleOf = () => page.form.querySelector('[data-edit-incidents-toggle]')!;
const cancelOf = () => page.form.querySelector('[data-edit-incidents-cancel]')!;
const displayOf = (input: FakeElement) => input.parentElement!.querySelector('[data-incidents-display]')!;
const asForm = (el: FakeElement) => el as unknown as HTMLFormElement;

beforeAll(async () => {
  vi.stubGlobal('document', {
    body: { dataset: {} },
    documentElement: {
      get clientWidth() {
        return page.viewportWidth;
      },
    },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    querySelector: (selector: string) => {
      if (selector === '[data-edit-incidents-error="edit-incidents-form"]') return page.error;
      if (selector === 'form[data-edit-incidents-form][data-editing="true"]')
        return page.form?.dataset.editing === 'true' ? page.form : null;
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'input[data-incidents-input][form="edit-incidents-form"]') return page.inputs;
      if (selector === 'form[data-edit-incidents-form]') return page.form ? [page.form] : [];
      return [];
    },
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    matchMedia: () => ({ matches: page.wide }),
  });
  ({ setEditing, placeEditControls, hasRoomBeside } = await import('../../src/scripts/editIncidents'));
});

beforeEach(() => {
  page.viewportWidth = 1280;
  page.wide = true;
  buildPage();
});

describe('edit mode (FR1.6, FR2.1, FR2.2)', () => {
  it('shows tick and cross, hides the pencil and hides every count behind its input', () => {
    setEditing(asForm(page.form), true);
    const toggle = toggleOf();
    expect(toggle.querySelector('[data-icon="edit"]')!.classes.has('hidden')).toBe(true);
    expect(toggle.querySelector('[data-icon="save"]')!.classes.has('hidden')).toBe(false);
    expect(cancelOf().classes.has('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Save results');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.classes.has('btn-primary')).toBe(true);
    for (const input of page.inputs) {
      expect(input.hidden).toBe(false);
      expect(displayOf(input).classes.has('hidden')).toBe(true);
    }
    expect(page.inputs[0].row!.marks[0].classes.has('hidden')).toBe(true);
  });

  it('hides the count with the hidden class, which beats its inline-block, not the hidden attribute', () => {
    setEditing(asForm(page.form), true);
    const display = displayOf(page.inputs[0]);
    expect(display.hidden).toBe(false);
    expect(display.classes.has('hidden')).toBe(true);
  });
});

describe('cancel (FR1.6)', () => {
  it('Escape restores the pencil, the counts and the values typed over', () => {
    setEditing(asForm(page.form), true);
    page.inputs[0].value = '9';
    const preventDefault = vi.fn();
    for (const fn of listeners.get('keydown') ?? []) fn({ key: 'Escape', target: page.inputs[0], preventDefault });

    const toggle = toggleOf();
    expect(preventDefault).toHaveBeenCalled();
    expect(page.form.dataset.editing).toBe('false');
    expect(page.inputs[0].value).toBe('3');
    expect(toggle.querySelector('[data-icon="edit"]')!.classes.has('hidden')).toBe(false);
    expect(toggle.querySelector('[data-icon="save"]')!.classes.has('hidden')).toBe(true);
    expect(cancelOf().classes.has('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Edit results');
    expect(toggle.classes.has('btn-neutral')).toBe(true);
    expect(toggle.focus).toHaveBeenCalled();
    for (const input of page.inputs) {
      expect(input.hidden).toBe(true);
      expect(displayOf(input).classes.has('hidden')).toBe(false);
    }
    expect(page.inputs[0].row!.marks[0].classes.has('hidden')).toBe(false);
  });

  it('clears an error shown during the edit', () => {
    page.error.hidden = false;
    page.error.textContent = 'Enter a whole number from 0 to 999 for Driver 1.';
    setEditing(asForm(page.form), false);
    expect(page.error.hidden).toBe(true);
    expect(page.error.textContent).toBe('');
  });
});

describe('room beside the table (FR1.5)', () => {
  it('needs the column width plus its gap between the table and the window edge', () => {
    expect(hasRoomBeside(1000, 1048, 40)).toBe(true);
    expect(hasRoomBeside(1000, 1047, 40)).toBe(false);
    expect(hasRoomBeside(1000, 900, 40)).toBe(false);
  });

  it('shows the column when it fits', () => {
    placeEditControls(asForm(page.form));
    expect(page.form.classes.has('hidden')).toBe(false);
    expect(page.form.classes.has('flex')).toBe(true);
  });

  it('hides the column when the window is too narrow beside the table', () => {
    page.viewportWidth = 1020;
    placeEditControls(asForm(page.form));
    expect(page.form.classes.has('hidden')).toBe(true);
    expect(page.form.classes.has('flex')).toBe(false);
  });

  it('hides the column below the sm breakpoint, where the incidents column is hidden', () => {
    page.wide = false;
    placeEditControls(asForm(page.form));
    expect(page.form.classes.has('hidden')).toBe(true);
  });

  it('cancels an open edit when the column is hidden, restoring the values', () => {
    placeEditControls(asForm(page.form));
    setEditing(asForm(page.form), true);
    page.inputs[0].value = '9';
    page.viewportWidth = 1010;
    placeEditControls(asForm(page.form));
    expect(page.form.classes.has('hidden')).toBe(true);
    expect(page.form.dataset.editing).toBe('false');
    expect(page.inputs[0].value).toBe('3');
    expect(page.inputs[0].hidden).toBe(true);
    expect(displayOf(page.inputs[0]).classes.has('hidden')).toBe(false);
  });

  it('keeps an open edit while the column still fits', () => {
    placeEditControls(asForm(page.form));
    setEditing(asForm(page.form), true);
    placeEditControls(asForm(page.form));
    expect(page.form.dataset.editing).toBe('true');
  });

  it('checks again when the window is resized', () => {
    placeEditControls(asForm(page.form));
    expect(page.form.classes.has('hidden')).toBe(false);
    page.viewportWidth = 1010;
    for (const fn of listeners.get('resize') ?? []) fn({ preventDefault: () => undefined });
    expect(page.form.classes.has('hidden')).toBe(true);
  });
});
