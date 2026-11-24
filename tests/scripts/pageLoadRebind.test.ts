/**
 * The page-load binders a Stats > Circuits row's astro:page-load re-dispatch runs again (past-results BR8.13,
 * NFR1.8, NFR2.2): each binds once however often it runs, and markup without their hooks binds nothing.
 * Runs in the fake DOM; `window` is stubbed because hard-form-submit.ts listens on it when imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDocument } from './fakeDom';

vi.mock('../../src/scripts/pageProgress', () => ({ showProgress: vi.fn(), hideProgress: vi.fn() }));

let doc: FakeDocument;
let initSortableTables: () => void;
let initCircuitSearch: () => void;
let bindForm: (form: HTMLFormElement) => void;

beforeEach(async () => {
  doc = installFakeDom();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.resetModules();
  ({ initSortableTables } = await import('../../src/scripts/sortable-table'));
  ({ initCircuitSearch } = await import('../../src/scripts/circuitSearch'));
  ({ bindForm } = await import('../../src/scripts/hard-form-submit'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('once-only binders (NFR7.5)', () => {
  it('binds a sortable table once across two runs', () => {
    const table = doc.createElement('table');
    table.setAttribute('data-sortable', '');
    let tHeadReads = 0;
    Object.defineProperty(table, 'tHead', {
      get: () => {
        tHeadReads += 1;
        return undefined;
      },
    });
    doc.body.append(table);
    initSortableTables();
    initSortableTables();
    expect(table.getAttribute('data-sortable-init')).toBe('true');
    expect(tHeadReads).toBe(1);
  });

  it('binds the circuit search input once across two runs', () => {
    const input = doc.createElement('input');
    input.setAttribute('id', 'circuit-search');
    const list = doc.createElement('tbody');
    list.setAttribute('id', 'circuit-list');
    doc.body.append(input, list);
    initCircuitSearch();
    initCircuitSearch();
    expect(input.getAttribute('data-search-bound')).toBe('true');
    expect(input.listeners.get('input')).toHaveLength(1);
  });

  it('binds a hard-submit form once across two runs', () => {
    const form = doc.createElement('form');
    bindForm(form as unknown as HTMLFormElement);
    bindForm(form as unknown as HTMLFormElement);
    expect(form.listeners.get('submit')).toHaveLength(1);
  });

  it('binds nothing and throws nothing over an old fragment with no table or search input', () => {
    const list = doc.createElement('div');
    for (let i = 0; i < 2; i += 1) {
      const item = doc.createElement('div');
      item.setAttribute('class', 'p-2.5');
      item.textContent = `#${i + 1} Contact at turn 1`;
      list.append(item);
    }
    doc.body.append(list);
    expect(() => {
      initSortableTables();
      initCircuitSearch();
    }).not.toThrow();
    expect(doc.querySelectorAll('[data-sortable-init]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-search-bound]')).toHaveLength(0);
  });
});
