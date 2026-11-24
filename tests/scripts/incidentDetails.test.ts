/**
 * The Incident Details popup script (src/scripts/incidentDetails.ts; past-results BR8.20, BR8.21, NFR5.1,
 * NFR1.8, NFR2.2, NFR3.5): a row opens its own scope's dialog and data, links inside a row keep their own
 * behaviour, the keyboard opens only from the focused row, focus goes back to the row on close, and each JSON
 * block is parsed once. Runs in the fake DOM; the script is imported fresh for each test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDocument, type FakeElement } from './fakeDom';

let doc: FakeDocument;

beforeEach(async () => {
  doc = installFakeDom();
  vi.resetModules();
  await import('../../src/scripts/incidentDetails');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function el(tag: string, attrs: Record<string, string> = {}, ...children: (FakeElement | string)[]) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function summary(driver: string, extra: Record<string, unknown> = {}) {
  return {
    driver,
    season: 'ATC18',
    round: 'Round 3',
    track: 'Lime Rock',
    date: 'Nov 3, 2026',
    session: 'Race 1',
    incidentNumber: '#4',
    lap: 7,
    involved: [],
    description: 'Contact at turn 1',
    offenses: ['Avoidable contact'],
    isWarning: false,
    pp: 2,
    time: null,
    points: 0,
    isAppealed: false,
    href: '/results/1/incidents',
    roundHref: '/results/1',
    ...extra,
  };
}

/** A JSON block like IncidentDetailsDialog's, with `safeJson`-style escaping unless `oldFormat`. */
function block(data: Record<string, unknown>, oldFormat = false) {
  let json = JSON.stringify(data).replace(/</g, '\\u003c');
  if (!oldFormat) json = json.replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const node = el('script', { type: 'application/json', 'data-history-incident-data': '' });
  node.textContent = json;
  return node;
}

/** A dialog built like the component's markup: title, the data-hi fields, the close button and the links. */
function dialog(titleId = 'incident-details-title') {
  const fields = ['round', 'when', 'driver', 'involved', 'race', 'lap', 'pp', 'time', 'points'].map((name) =>
    el('dd', { 'data-hi': name }),
  );
  return el(
    'dialog',
    { 'data-history-incident-dialog': '', 'aria-labelledby': titleId },
    el('h4', { id: titleId, 'data-hi': 'title' }, 'Incident'),
    el('button', { type: 'button', 'data-close-history-incident': '', 'aria-label': 'Close' }, '✕'),
    ...fields,
    el('div', { 'data-hi-row': 'description', class: 'hidden' }, el('dd', { 'data-hi': 'description' })),
    el('div', { 'data-hi-row': 'offenses', class: 'hidden' }, el('dd', { 'data-hi': 'offenses' })),
    el('div', { 'data-hi-row': 'appealed', class: 'hidden' }),
    el('a', { 'data-hi-link': 'round', href: '#' }),
    el('a', { 'data-hi-link': 'report', href: '#' }),
  );
}

function row(id: string) {
  return el(
    'tr',
    { 'data-history-incident': id, tabindex: '0', role: 'button' },
    el('td', {}, el('a', { href: '/results/1' }, 'ATC18 R3')),
    el('td', {}, 'Driver'),
  );
}

const text = (d: FakeElement, name: string) => d.querySelector(`[data-hi="${name}"]`)!.textContent;
const link = (r: FakeElement) => r.querySelector('a')!;

describe('scopes (BR8.20)', () => {
  it('opens each scope’s own dialog with its own data for the same incident id', () => {
    const rowA = row('i1');
    const rowB = row('i1');
    const dialogA = dialog('t-a');
    const dialogB = dialog('t-b');
    doc.body.append(
      el('div', { 'data-incident-details-scope': '' }, rowA, block({ i1: summary('#1 Alpha') }), dialogA),
      el('div', { 'data-incident-details-scope': '' }, rowB, block({ i1: summary('#2 Bravo') }), dialogB),
    );
    rowB.click();
    expect(dialogB.open).toBe(true);
    expect(dialogA.open).toBe(false);
    expect(text(dialogB, 'driver')).toBe('#2 Bravo');
    rowA.click();
    expect(dialogA.open).toBe(true);
    expect(text(dialogA, 'driver')).toBe('#1 Alpha');
  });

  it('uses the page’s first block and dialog for a row with no scope', () => {
    const r = row('i1');
    const d = dialog();
    doc.body.append(r, block({ i1: summary('#7 Page') }), d, block({ i1: summary('#8 Later') }), dialog());
    r.click();
    expect(d.open).toBe(true);
    expect(text(d, 'driver')).toBe('#7 Page');
  });

  it('opens an old-format block (only < escaped) with the same text', () => {
    const r = row('i1');
    const d = dialog();
    doc.body.append(r, block({ i1: summary('#3 A & B > C', { description: 'x </script> y' }) }, true), d);
    r.click();
    expect(text(d, 'driver')).toBe('#3 A & B > C');
    expect(text(d, 'description')).toBe('x </script> y');
  });

  it('opens nothing and throws nothing inside an old fragment with no trigger, scope or block', () => {
    const plain = el('li', {}, el('span', {}, 'Old incident'));
    doc.body.append(el('ul', {}, plain));
    expect(() => plain.click()).not.toThrow();
    expect(doc.querySelectorAll('dialog')).toHaveLength(0);
  });
});

describe('links and keyboard (BR8.21, NFR5.1)', () => {
  function setup() {
    const r = row('i1');
    const d = dialog();
    doc.body.append(el('table', {}, el('tbody', {}, r)), block({ i1: summary('#1 Alpha') }), d);
    return { r, d };
  }

  it('lets a click on a link inside a row follow the link and opens nothing', () => {
    const { r, d } = setup();
    link(r).click();
    expect(d.open).toBe(false);
  });

  it('opens on Enter and on Space from the focused row, and prevents the default', () => {
    const { r, d } = setup();
    r.focus();
    const enter = r.dispatch('keydown', { key: 'Enter' });
    expect(d.open).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    d.close();
    const space = r.dispatch('keydown', { key: ' ' });
    expect(d.open).toBe(true);
    expect(space.defaultPrevented).toBe(true);
  });

  it('leaves Enter on a focused link inside the row to the link', () => {
    const { r, d } = setup();
    link(r).focus();
    const enter = link(r).dispatch('keydown', { key: 'Enter' });
    expect(d.open).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('ignores other keys on the row', () => {
    const { r, d } = setup();
    const tab = r.dispatch('keydown', { key: 'Tab' });
    expect(d.open).toBe(false);
    expect(tab.defaultPrevented).toBe(false);
  });
});

describe('parsing and text (NFR1.8, NFR3.5)', () => {
  it('parses a block once for repeated opens, and reads a replaced block fresh', () => {
    const r = row('i1');
    const d = dialog();
    const scope = el('div', { 'data-incident-details-scope': '' }, r, block({ i1: summary('#1 Old') }), d);
    doc.body.append(scope);
    const parse = vi.spyOn(JSON, 'parse');
    let parsesForOneBlock = -1;
    try {
      r.click();
      d.close();
      r.click();
      parsesForOneBlock = parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }
    expect(parsesForOneBlock).toBe(1);

    d.close();
    scope.querySelector('[data-history-incident-data]')!.remove();
    scope.append(block({ i1: summary('#1 New') }));
    r.click();
    expect(text(d, 'driver')).toBe('#1 New');
  });

  it('sets markup in a description as literal text', () => {
    const r = row('i1');
    const d = dialog();
    doc.body.append(r, block({ i1: summary('#1 Alpha', { description: '<b>x</b>' }) }), d);
    r.click();
    const description = d.querySelector('[data-hi="description"]')!;
    expect(description.textContent).toBe('<b>x</b>');
    expect(description.children).toHaveLength(0);
  });

  it('lists each offense as its own text element', () => {
    const r = row('i1');
    const d = dialog();
    doc.body.append(r, block({ i1: summary('#1 Alpha', { offenses: ['<i>One</i>', 'Two'] }) }), d);
    r.click();
    const offenses = d.querySelector('[data-hi="offenses"]')!;
    expect(offenses.children.map((c) => c.textContent)).toEqual(['<i>One</i>', 'Two']);
  });
});

describe('closing and focus (NFR5.1)', () => {
  function openFromRow() {
    const r = row('i1');
    const d = dialog();
    doc.body.append(r, block({ i1: summary('#1 Alpha') }), d);
    r.focus();
    r.click();
    d.querySelector('[data-hi="driver"]')!.focus();
    return { r, d };
  }

  it('returns focus to the row after Escape', () => {
    const { r, d } = openFromRow();
    d.close();
    expect(d.open).toBe(false);
    expect(doc.activeElement).toBe(r);
  });

  it('returns focus to the row after the close button', () => {
    const { r, d } = openFromRow();
    d.querySelector('[data-close-history-incident]')!.click();
    expect(d.open).toBe(false);
    expect(doc.activeElement).toBe(r);
  });

  it('returns focus to the row after a backdrop click', () => {
    const { r, d } = openFromRow();
    d.click();
    expect(d.open).toBe(false);
    expect(doc.activeElement).toBe(r);
  });

  it('names its heading through aria-labelledby', () => {
    const d = dialog('incident-details-title-layout-7');
    const heading = d.querySelector('h4')!;
    expect(d.getAttribute('aria-labelledby')).toBe(heading.id);
  });
});
