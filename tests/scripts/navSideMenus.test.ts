/**
 * The desktop nav's side menus (src/scripts/navSideMenus.ts; nav-side-menus BR1.7-BR1.11, NFR5.1, NFR5.2):
 * the keyboard table, the flip rule, and opening, moving and closing on a fake document. The fake DOM's
 * focus() does not fire focusout, so the tests dispatch it; it has no layout, so placement is tested only
 * through shouldFlip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeDocument, type FakeElement, installFakeDom } from './fakeDom';
import { FLIP_MARGIN, initNavSideMenus, shouldFlip, sideMenuKeyAction } from '../../src/scripts/navSideMenus';

type Row = { row: FakeElement; parent: FakeElement; toggle: FakeElement; links: FakeElement[] };

function buildRow(doc: FakeDocument, labels: string[]): Row {
  const el = (tag: string, attrs: Record<string, string> = {}) => {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const row = el('div', { 'data-nav-side': '' });
  const parent = el('a', { 'data-nav-side-parent': '' });
  const toggle = el('button', { 'data-nav-side-toggle': '', 'aria-expanded': 'false' });
  const panel = el('div', { 'data-nav-side-panel': '' });
  const links = labels.map((label) => {
    const a = el('a', { 'data-nav-side-link': '' });
    a.textContent = label;
    return a;
  });
  panel.append(...links);
  row.append(parent, toggle, panel);
  doc.body.append(row);
  return { row, parent, toggle, links };
}

const key = (target: FakeElement, k: string) => target.dispatch('keydown', { key: k });

let doc: FakeDocument;
let drivers: Row;
let teams: Row;
let outside: FakeElement;

beforeEach(() => {
  doc = installFakeDom();
  drivers = buildRow(doc, ['Overall', 'Gamma', 'Delta']);
  teams = buildRow(doc, ['Overall', 'Delta']);
  outside = doc.createElement('a');
  doc.body.append(outside);
  initNavSideMenus(doc as unknown as Document);
});

afterEach(() => vi.unstubAllGlobals());

describe('sideMenuKeyAction (the keyboard table)', () => {
  it('opens on Right Arrow from the parent link or the toggle, and nothing else there', () => {
    expect(sideMenuKeyAction('ArrowRight', 'parent')).toBe('open');
    expect(sideMenuKeyAction('ArrowRight', 'toggle')).toBe('open');
    for (const k of ['Enter', ' ', 'ArrowDown', 'Escape', 'Tab', 'ArrowLeft']) {
      expect(sideMenuKeyAction(k, 'parent'), k).toBeNull();
      expect(sideMenuKeyAction(k, 'toggle'), k).toBeNull();
    }
  });

  it('moves and closes inside the side menu, leaving Right Arrow, Enter and Tab to the browser', () => {
    expect(sideMenuKeyAction('ArrowDown', 'item')).toBe('next');
    expect(sideMenuKeyAction('ArrowUp', 'item')).toBe('prev');
    expect(sideMenuKeyAction('Home', 'item')).toBe('first');
    expect(sideMenuKeyAction('End', 'item')).toBe('last');
    expect(sideMenuKeyAction('Escape', 'item')).toBe('close');
    expect(sideMenuKeyAction('ArrowLeft', 'item')).toBe('close');
    for (const k of ['ArrowRight', 'Enter', 'Tab', 'a']) expect(sideMenuKeyAction(k, 'item'), k).toBeNull();
  });
});

describe('shouldFlip (BR1.11)', () => {
  it(`flips only when the panel passes ${FLIP_MARGIN} px from the right edge`, () => {
    expect(shouldFlip(1000 - FLIP_MARGIN - 1, 1000)).toBe(false);
    expect(shouldFlip(1000 - FLIP_MARGIN, 1000)).toBe(false);
    expect(shouldFlip(1000 - FLIP_MARGIN + 1, 1000)).toBe(true);
    expect(shouldFlip(1400, 1000)).toBe(true);
  });
});

describe('opening (BR1.7, BR1.10)', () => {
  it('opens on Right Arrow from the parent link, focusing the first link', () => {
    const event = key(drivers.parent, 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(drivers.row.hasAttribute('data-open')).toBe(true);
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(doc.activeElement).toBe(drivers.links[0]);
  });

  it('opens on Right Arrow from the toggle', () => {
    key(drivers.toggle, 'ArrowRight');
    expect(drivers.row.hasAttribute('data-open')).toBe(true);
    expect(doc.activeElement).toBe(drivers.links[0]);
  });

  it('opens on a toggle click (Enter, Space or the mouse), and a second click closes with focus kept', () => {
    drivers.toggle.focus();
    drivers.toggle.click();
    expect(drivers.row.hasAttribute('data-open')).toBe(true);
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(doc.activeElement).toBe(drivers.links[0]);

    drivers.toggle.focus();
    drivers.toggle.click();
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('false');
    // Dismissed, so a panel shown by hover does not stay visible under the pointer after the click closes it.
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(true);
    expect(doc.activeElement).toBe(drivers.toggle);
  });

  it('keeps one side menu open at a time', () => {
    key(drivers.parent, 'ArrowRight');
    key(teams.parent, 'ArrowRight');
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(teams.row.hasAttribute('data-open')).toBe(true);
    expect(doc.activeElement).toBe(teams.links[0]);
  });
});

describe('moving inside (BR1.8)', () => {
  beforeEach(() => key(drivers.parent, 'ArrowRight'));

  it('moves down and up, wrapping at both ends', () => {
    key(drivers.links[0], 'ArrowDown');
    expect(doc.activeElement).toBe(drivers.links[1]);
    key(drivers.links[2], 'ArrowDown');
    expect(doc.activeElement).toBe(drivers.links[0]);
    key(drivers.links[0], 'ArrowUp');
    expect(doc.activeElement).toBe(drivers.links[2]);
    key(drivers.links[2], 'ArrowUp');
    expect(doc.activeElement).toBe(drivers.links[1]);
  });

  it('jumps to the first and last with Home and End', () => {
    expect(key(drivers.links[0], 'End').defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(drivers.links[2]);
    key(drivers.links[2], 'Home');
    expect(doc.activeElement).toBe(drivers.links[0]);
  });
});

describe('closing (BR1.9)', () => {
  beforeEach(() => key(drivers.parent, 'ArrowRight'));

  it.each(['Escape', 'ArrowLeft'])(
    '%s closes, focuses the toggle and stays dismissed under the pointer',
    (k) => {
      key(drivers.links[1], k);
      expect(drivers.row.hasAttribute('data-open')).toBe(false);
      expect(drivers.toggle.getAttribute('aria-expanded')).toBe('false');
      expect(drivers.row.hasAttribute('data-dismissed')).toBe(true);
      expect(doc.activeElement).toBe(drivers.toggle);
    },
  );

  it('clears the dismissal once the pointer leaves the row, not while it moves inside it', () => {
    key(drivers.links[0], 'Escape');
    drivers.links[0].dispatch('mouseout', { relatedTarget: drivers.toggle });
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(true);
    drivers.toggle.dispatch('mouseout', { relatedTarget: outside });
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(false);
  });

  it('clears a keyboard dismissal when the pointer next enters the row', () => {
    key(drivers.links[0], 'Escape');
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(true);
    drivers.toggle.dispatch('mouseover', { relatedTarget: drivers.parent });
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(true);
    drivers.parent.dispatch('mouseover', { relatedTarget: outside });
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(false);
  });

  it('closes when focus leaves the row, without moving it, and stays open while it moves inside', () => {
    drivers.links[0].dispatch('focusout', { relatedTarget: drivers.links[1] });
    expect(drivers.row.hasAttribute('data-open')).toBe(true);
    outside.focus();
    drivers.links[1].dispatch('focusout', { relatedTarget: outside });
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drivers.row.hasAttribute('data-dismissed')).toBe(false);
    expect(doc.activeElement).toBe(outside);
  });

  it('closes when focus goes nowhere (a click on the page)', () => {
    drivers.links[0].dispatch('focusout', { relatedTarget: null });
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
  });
});

describe('binding and scope (NFR5.1, NFR5.2)', () => {
  it('binds once, so one key press moves focus one step', () => {
    initNavSideMenus(doc as unknown as Document);
    key(drivers.parent, 'ArrowRight');
    key(drivers.links[0], 'ArrowDown');
    expect(doc.activeElement).toBe(drivers.links[1]);
  });

  it('leaves keys outside a side-menu row, and unhandled keys inside one, to the browser', () => {
    for (const k of ['ArrowRight', 'ArrowDown', 'Escape', 'Home']) {
      expect(key(outside, k).defaultPrevented, k).toBe(false);
    }
    expect(key(drivers.parent, 'Enter').defaultPrevented).toBe(false);
    expect(key(drivers.parent, 'Tab').defaultPrevented).toBe(false);
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
  });

  it('never changes aria-expanded on hover', () => {
    drivers.parent.dispatch('mouseover', { relatedTarget: outside });
    drivers.parent.dispatch('mouseout', { relatedTarget: outside });
    expect(drivers.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drivers.row.hasAttribute('data-open')).toBe(false);
  });
});
