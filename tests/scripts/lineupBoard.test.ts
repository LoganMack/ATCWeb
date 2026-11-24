/**
 * The Lineup Changes highlight (src/scripts/lineupBoard.ts; BR1.22, NFR1.5, NFR5.1): hover and keyboard focus
 * on a changed seat highlight its seats and line and show its label; leaving clears them; a board binds once.
 * Drawn into a small fake document (tests/scripts/fakeDom.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDocument, type FakeElement } from './fakeDom';

let doc: FakeDocument;
let mod: typeof import('../../src/scripts/lineupBoard');

beforeEach(async () => {
  doc = installFakeDom();
  vi.resetModules();
  mod = await import('../../src/scripts/lineupBoard');
});
afterEach(() => vi.unstubAllGlobals());

function el(tag: string, attrs: Record<string, string> = {}, ...children: FakeElement[]): FakeElement {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/** Ruiz (d1, linked) and a hidden mover (d2, a focusable seat) in both columns, plus a stayer. */
function drawBoard() {
  const ruizLink = el('a', { href: '/drivers/x' });
  const seats = {
    ruizLeft: el('li', { 'data-seat': '', 'data-key': 'd1', 'data-label': 'Ruiz: Redline → Apex' }, ruizLink),
    hiddenLeft: el('li', {
      'data-seat': '',
      'data-key': 'd2',
      'data-label': 'Hidden Driver: Volt → Apex',
      tabindex: '0',
    }),
    stayer: el('li', { 'data-seat': '' }),
    ruizRight: el('li', { 'data-seat': '', 'data-key': 'd1', 'data-label': 'Ruiz: Redline → Apex' }),
    hiddenRight: el('li', { 'data-seat': '', 'data-key': 'd2', 'data-label': 'Hidden Driver: Volt → Apex' }),
  };
  const label = el('p', { 'data-lineup-label': '', 'aria-hidden': 'true' });
  const lines = { d1: el('path', { 'data-line': 'd1' }), d2: el('path', { 'data-line': 'd2' }) };
  const board = el(
    'figure',
    { 'data-lineup-board': '' },
    label,
    el('ul', {}, seats.ruizLeft, seats.hiddenLeft, seats.stayer),
    el('svg', {}, lines.d1, lines.d2),
    el('ul', {}, seats.ruizRight, seats.hiddenRight),
  );
  doc.body.append(board);
  return { board, seats, label, lines, ruizLink };
}

const has = (node: FakeElement, name: string) => node.classList.contains(name);

describe('lineup board highlight', () => {
  it('highlights a hovered seat, its twin and its line, fades the others, and clears on leaving', () => {
    const { board, seats, label, lines, ruizLink } = drawBoard();
    mod.initLineupBoards();
    ruizLink.dispatch('pointerover');
    expect(board.getAttribute('data-active-key')).toBe('d1');
    expect(label.textContent).toBe('Ruiz: Redline → Apex');
    expect([seats.ruizLeft, seats.ruizRight, lines.d1].every((n) => has(n, 'is-active'))).toBe(true);
    expect([seats.hiddenLeft, seats.hiddenRight, lines.d2].every((n) => has(n, 'opacity-30'))).toBe(true);
    expect(has(seats.stayer, 'opacity-30')).toBe(false);

    // Moving onto another changed seat leaves its own pointerover to switch the highlight.
    ruizLink.dispatch('pointerout', { relatedTarget: seats.hiddenRight });
    expect(board.getAttribute('data-active-key')).toBe('d1');
    seats.hiddenRight.dispatch('pointerover');
    expect(label.textContent).toBe('Hidden Driver: Volt → Apex');

    seats.hiddenRight.dispatch('pointerout', { relatedTarget: seats.stayer });
    expect(board.hasAttribute('data-active-key')).toBe(false);
    expect(label.textContent).toBe('');
    expect(
      [...Object.values(seats), ...Object.values(lines)].some(
        (n) => has(n, 'opacity-30') || has(n, 'is-active'),
      ),
    ).toBe(false);
  });

  it('highlights on keyboard focus of a link or a focusable seat, and clears when focus leaves the board', () => {
    const { board, seats, label } = drawBoard();
    mod.initLineupBoards();
    seats.hiddenLeft.dispatch('focusin');
    expect(board.getAttribute('data-active-key')).toBe('d2');
    expect(label.textContent).toBe('Hidden Driver: Volt → Apex');
    seats.hiddenLeft.dispatch('focusout', { relatedTarget: null });
    expect(board.hasAttribute('data-active-key')).toBe(false);
    expect(label.textContent).toBe('');
    // A stayer has no key, so it highlights nothing.
    seats.stayer.dispatch('focusin');
    expect(board.hasAttribute('data-active-key')).toBe(false);
  });

  it('binds each board once, however often astro:page-load fires', () => {
    const { board, ruizLink } = drawBoard();
    const apply = vi.spyOn(board, 'addEventListener');
    mod.initLineupBoards();
    mod.initLineupBoards();
    for (const fn of doc.listeners.get('astro:page-load') ?? []) fn({} as never);
    expect(board.hasAttribute('data-bound')).toBe(true);
    expect(apply).toHaveBeenCalledTimes(4);
    ruizLink.dispatch('pointerover');
    expect(board.getAttribute('data-active-key')).toBe('d1');
  });

  it('finds the key of the changed seat around a target, and none for a stayer or nothing', () => {
    const { seats, ruizLink } = drawBoard();
    expect(mod.activeKeyFor(ruizLink as unknown as Element)).toBe('d1');
    expect(mod.activeKeyFor(seats.stayer as unknown as Element)).toBeNull();
    expect(mod.activeKeyFor(null)).toBeNull();
  });
});
