/**
 * The circuit editor's browser script (src/scripts/circuitEditor.ts; circuit-editor BR1.5, BR1.14, BR1.19,
 * NFR7.6) on the fake DOM: dialogs open with focus on the first or failing field, Cancel and Escape reset the
 * form and return focus, a refused save reopens on load, the guide dialog takes its layout from the opener,
 * and the Logo Background custom row keeps the picker, the text and the preview in step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDocument, type FakeElement } from './fakeDom';
import {
  applyPreview,
  initCircuitEditor,
  resetCircuitEditorForTests,
  showCustomRow,
  syncFromText,
} from '../../src/scripts/circuitEditor';

let doc: FakeDocument;

function el(tag: string, attrs: Record<string, string> = {}, ...children: FakeElement[]): FakeElement {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** A form with a reset() stub, which fakeDom does not model. */
function formEl(...children: FakeElement[]) {
  const form = el('form', {}, ...children);
  const reset = vi.fn();
  Object.assign(form, { reset });
  return { form, reset };
}

interface Page {
  circuitForm: FakeElement;
  fieldset: FakeElement;
  radios: Record<string, FakeElement>;
  row: FakeElement;
  picker: FakeElement;
  text: FakeElement;
  preview: FakeElement;
  setProperty: ReturnType<typeof vi.fn>;
  addLayout: FakeElement;
  newDialog: FakeElement;
  newName: FakeElement;
  newCancel: FakeElement;
  newReset: ReturnType<typeof vi.fn>;
  guideButton: FakeElement;
  guideDialog: FakeElement;
  guideLayoutId: FakeElement;
  deleteButton: FakeElement;
}

function buildPage(opts: { refusedDialog?: boolean } = {}): Page {
  const setProperty = vi.fn();
  const preview = el('img', { 'data-logo-preview': '' });
  Object.assign(preview, { style: { setProperty } });

  const radios: Record<string, FakeElement> = {};
  const radioLabels = ['', 'light', 'dark', 'custom'].map((value) => {
    radios[value || 'none'] = el('input', { type: 'radio', name: 'logo_background', value });
    return el('label', {}, radios[value || 'none']);
  });
  radios.none.checked = true;
  const picker = el('input', { type: 'color', value: '#4369f5' });
  const text = el('input', { type: 'text', name: 'logo_background_hex', value: '#4369f5' });
  const row = el('div', { 'data-logo-bg-custom-row': '', hidden: '' }, picker, el('label', {}, text));
  const fieldset = el('fieldset', { 'data-logo-bg-fieldset': '' }, ...radioLabels, row);
  const circuitForm = el('form', { 'data-circuit-form': '' }, preview, fieldset);

  const addLayout = el('button', { type: 'button', 'data-open-dialog': 'layout-dialog-new' });
  const newName = el('input', { name: 'layout_name', 'data-first-field': '' });
  const newCategory = el('select', { name: 'category' });
  if (opts.refusedDialog) {
    newCategory.setAttribute('aria-invalid', 'true');
  }
  const newCancel = el('button', { type: 'button', 'data-close-dialog': '' });
  const { form: newForm, reset: newReset } = formEl(newName, newCategory, newCancel);
  const newDialog = el(
    'dialog',
    { id: 'layout-dialog-new', ...(opts.refusedDialog ? { 'data-open-on-load': '' } : {}) },
    newForm,
  );

  const guideButton = el('button', {
    type: 'button',
    'data-open-dialog': 'track-guide-dialog',
    'data-layout-id': 'layout-7',
  });
  const guideLayoutId = el('input', { type: 'hidden', name: 'layout_id', value: '' });
  const { form: guideForm } = formEl(guideLayoutId, el('input', { name: 'title', 'data-first-field': '' }));
  const guideDialog = el('dialog', { id: 'track-guide-dialog' }, guideForm);

  const deleteButton = el('button', { type: 'submit', 'data-confirm': 'Delete this circuit?' });

  doc.body.append(circuitForm, addLayout, guideButton, newDialog, guideDialog, el('form', {}, deleteButton));
  return {
    circuitForm,
    fieldset,
    radios,
    row,
    picker,
    text,
    preview,
    setProperty,
    addLayout,
    newDialog,
    newName,
    newCancel,
    newReset,
    guideButton,
    guideDialog,
    guideLayoutId,
    deleteButton,
  };
}

beforeEach(() => {
  doc = installFakeDom();
  resetCircuitEditorForTests();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('layout dialogs (BR1.14)', () => {
  it('opens on the + button and focuses the first field', () => {
    const page = buildPage();
    initCircuitEditor();
    page.addLayout.click();
    expect(page.newDialog.open).toBe(true);
    expect(doc.activeElement).toBe(page.newName);
  });

  it('resets the form and returns focus to the opener on Cancel and on Escape', () => {
    const page = buildPage();
    initCircuitEditor();

    page.addLayout.click();
    page.newCancel.click();
    expect(page.newDialog.open).toBe(false);
    expect(page.newReset).toHaveBeenCalledTimes(1);
    expect(doc.activeElement).toBe(page.addLayout);

    page.addLayout.click();
    // Escape closes a native dialog and fires `close`.
    (page.newDialog as unknown as { close(): void }).close();
    expect(page.newReset).toHaveBeenCalledTimes(2);
    expect(doc.activeElement).toBe(page.addLayout);
  });

  it('reopens a refused dialog on load, focused on its failing field (BR1.19)', () => {
    const page = buildPage({ refusedDialog: true });
    initCircuitEditor();
    expect(page.newDialog.open).toBe(true);
    expect(doc.activeElement?.getAttribute('name')).toBe('category');
  });

  it('gives the track guide dialog the layout id of its opener', () => {
    const page = buildPage();
    initCircuitEditor();
    page.guideButton.click();
    expect(page.guideDialog.open).toBe(true);
    expect(page.guideLayoutId.value).toBe('layout-7');
  });

  it('binds once, however often it runs', () => {
    const page = buildPage();
    initCircuitEditor();
    initCircuitEditor();
    page.deleteButton.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    page.addLayout.click();
    page.newCancel.click();
    expect(page.newReset).toHaveBeenCalledTimes(1);
  });

  it('keeps the delete confirm, cancelling the submit when declined', () => {
    const page = buildPage();
    vi.stubGlobal('confirm', vi.fn(() => false));
    initCircuitEditor();
    const event = page.deleteButton.dispatch('click');
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('Logo Background (BR1.5)', () => {
  function choose(page: Page, mode: 'none' | 'light' | 'dark' | 'custom') {
    for (const radio of Object.values(page.radios)) radio.checked = false;
    page.radios[mode].checked = true;
    page.radios[mode].dispatch('change');
  }

  it('shows the custom row for Custom and hides it for None', () => {
    const page = buildPage();
    initCircuitEditor();
    choose(page, 'custom');
    expect(page.row.hidden).toBe(false);
    expect(showCustomRow(page.fieldset as unknown as HTMLElement)).toBe('custom');
    choose(page, 'none');
    expect(page.row.hidden).toBe(true);
    expect(page.preview.hasAttribute('data-logo-bg')).toBe(false);
    choose(page, 'dark');
    expect(page.preview.getAttribute('data-logo-bg')).toBe('dark');
  });

  it('copies the picker into the text and draws the preview', () => {
    const page = buildPage();
    initCircuitEditor();
    choose(page, 'custom');
    page.picker.value = '#112233';
    page.picker.dispatch('input');
    expect(page.text.value).toBe('#112233');
    expect(page.preview.getAttribute('data-logo-bg')).toBe('custom');
    expect(page.setProperty).toHaveBeenLastCalledWith('--logo-bg', '#112233');
  });

  it('moves the picker and the preview to valid typed text, normalised', () => {
    const page = buildPage();
    initCircuitEditor();
    choose(page, 'custom');
    page.text.value = 'rgb(67, 105, 245)';
    page.text.dispatch('input');
    expect(page.picker.value).toBe('#4369f5');
    expect(page.setProperty).toHaveBeenLastCalledWith('--logo-bg', '#4369f5');
    page.text.value = '#ABC';
    page.text.dispatch('input');
    expect(page.picker.value).toBe('#aabbcc');
  });

  it('leaves the picker and the preview alone for invalid text', () => {
    const page = buildPage();
    initCircuitEditor();
    page.text.value = 'red;}';
    page.text.dispatch('input');
    expect(page.picker.value).toBe('#4369f5');
    expect(page.setProperty).not.toHaveBeenCalled();
    expect(page.preview.hasAttribute('data-logo-bg')).toBe(false);
    expect(syncFromText(page.row as unknown as HTMLElement)).toBeNull();
  });

  it('applyPreview ignores a null colour and a missing image', () => {
    const page = buildPage();
    applyPreview(page.preview as unknown as HTMLElement, null);
    applyPreview(null, '#000000');
    expect(page.setProperty).not.toHaveBeenCalled();
  });
});
