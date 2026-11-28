/**
 * The Lineup Changes highlight (src/scripts/lineupBoard.ts; BR1.22, NFR1.5, NFR5.1): hover and keyboard focus
 * on a changed seat highlight its seats and line and show its label; leaving clears them; a board binds once.
 * The Teams filter fills its list from the board, hides unticked teams and relays the rows and lines out,
 * with Select All, search and the toggle label. Drawn into a small fake document (tests/scripts/fakeDom.ts).
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

/** The shell's Teams dropdown, as src/pages/advanced-stats.astro renders it (the list starts empty). */
function drawDropdown() {
  const toggle = el('button', { 'data-lineup-team-toggle': '', disabled: '', 'aria-expanded': 'false' });
  const label = el('span', { 'data-lineup-team-label': '' });
  toggle.append(label);
  label.textContent = 'All teams';
  const search = el('input', { type: 'search', 'data-lineup-team-search': '' });
  const all = el('input', { type: 'checkbox', checked: '', 'data-lineup-team-all': '' });
  const list = el('div', { 'data-lineup-team-list': '' });
  const panel = el(
    'div',
    { class: 'hidden', 'data-lineup-team-panel': '' },
    search,
    el('label', {}, all),
    list,
  );
  const dropdown = el('div', { 'data-lineup-team-dropdown': '' }, toggle, panel);
  doc.body.append(dropdown);
  return { dropdown, toggle, label, panel, search, all, list };
}

/**
 * The fragment as lineups/fragment.astro renders it: apex (t1), Redline (t2), Volt (t3). Carter stays at apex,
 * Ruiz (d1) moves Redline -> apex, Petrov (d2) joins Volt, Lind (d3) leaves Volt.
 */
function drawFragment() {
  const seat = (key: string | null, team: string) =>
    el('li', { 'data-seat': '', 'data-team': team, ...(key ? { 'data-key': key, 'data-label': key } : {}) });
  const group = (kind: string, team: string | null, ...seats: FakeElement[]) =>
    el('li', { 'data-group': kind, ...(team ? { 'data-team': team } : {}) }, el('ul', {}, ...seats));
  const s = {
    carterL: seat(null, 't1'),
    ruizL: seat('d1', 't2'),
    lindL: seat('d3', 't3'),
    petrovL: seat('d2', 't3'),
    ruizR: seat('d1', 't1'),
    carterR: seat(null, 't1'),
    petrovR: seat('d2', 't3'),
    lindR: seat('d3', 't3'),
  };
  const g = {
    apexL: group('team', 't1', s.carterL),
    redlineL: group('team', 't2', s.ruizL),
    voltL: group('team', 't3', s.lindL),
    joined: group('joined', null, s.petrovL),
    apexR: group('team', 't1', s.ruizR, s.carterR),
    voltR: group('team', 't3', s.petrovR),
    left: group('left', null, s.lindR),
  };
  const lines = {
    d1: el('path', { 'data-line': 'd1' }),
    d2: el('path', { 'data-line': 'd2' }),
    d3: el('path', { 'data-line': 'd3' }),
  };
  const svg = el('svg', { 'data-lineup-lines': '', viewBox: '0 0 100 28' }, lines.d1, lines.d2, lines.d3);
  const none = el('p', { class: 'hidden', 'data-lineup-none': '' });
  const cardsNone = el('p', { class: 'hidden', 'data-lineup-none': '' });
  const board = el(
    'figure',
    { 'data-lineup-board': '' },
    el('p', { 'data-lineup-label': '' }),
    none,
    el('ul', { 'data-lineup-column': 'left' }, g.apexL, g.redlineL, g.voltL, g.joined),
    el('ul', { 'data-lineup-column': 'right' }, g.apexR, g.voltR, g.left),
    svg,
  );
  const cards = {
    apex: el('section', { 'data-team': 't1' }),
    volt: el('section', { 'data-team': 't3' }),
    left: el('section', { 'data-lineup-left-card': '' }, el('ul', {}, el('li', { 'data-team': 't3' }))),
  };
  const teams = el(
    'ul',
    { class: 'hidden', 'data-lineup-teams': '' },
    ...[
      ['t1', 'apex Racing'],
      ['t2', 'Redline'],
      ['t3', 'Volt GP'],
    ].map(([key, name]) => {
      const li = el('li', { 'data-team': key });
      li.textContent = name;
      return li;
    }),
  );
  const root = el(
    'section',
    { 'data-lineups': '' },
    teams,
    board,
    el('div', { 'data-lineup-cards': '' }, cardsNone, cards.apex, cards.volt, cards.left),
  );
  doc.body.append(root);
  return { root, board, s, g, lines, svg, none, cardsNone, cards };
}

const hidden = (node: FakeElement) => node.classList.contains('hidden');

function setup() {
  const ui = drawDropdown();
  const page = drawFragment();
  mod.initLineupBoards();
  const boxes = () => ui.list.querySelectorAll('[data-lineup-team-option]');
  const box = (key: string) => boxes().find((b) => b.value === key)!;
  const tick = (key: string, on: boolean) => {
    box(key).checked = on;
    box(key).dispatch('change');
  };
  return { ...ui, ...page, boxes, box, tick };
}

describe('lineup Teams filter', () => {
  it('fills the list A to Z from the board, ticked, and enables the toggle', () => {
    const { toggle, label, boxes, all } = setup();
    expect(toggle.disabled).toBe(false);
    expect(boxes().map((b) => [b.value, b.closest('label')?.textContent, b.checked])).toEqual([
      ['t1', 'apex Racing', true],
      ['t2', 'Redline', true],
      ['t3', 'Volt GP', true],
    ]);
    expect(label.textContent).toBe('All teams');
    expect([all.checked, all.indeterminate]).toEqual([true, false]);
  });

  it('keeps the toggle disabled while the season shows a message instead of a board', () => {
    const { toggle } = drawDropdown();
    doc.body.append(el('section', { 'data-lineups': '' }, el('p', { 'data-testid': 'lineups-message' })));
    mod.initLineupBoards();
    expect(toggle.disabled).toBe(true);
  });

  it('hides an unticked team in both columns, closes the gap and redraws the lines and viewBox', () => {
    const { tick, g, s, lines, svg, label } = setup();
    tick('t2', false);
    expect(hidden(g.redlineL)).toBe(true);
    expect(hidden(s.ruizL)).toBe(true);
    // Ruiz's left end is gone, so his line goes; the others meet their seats' new rows.
    expect(hidden(lines.d1)).toBe(true);
    // Left: apex 0-5 | gap | Volt (Lind 8.5) | gap | heading 12-17, Petrov 19.5. Right is unchanged.
    expect(lines.d2.getAttribute('d')).toBe('M0 19.5 C50 19.5 50 13.5 100 13.5');
    expect(lines.d3.getAttribute('d')).toBe('M0 8.5 C50 8.5 50 24.5 100 24.5');
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 27');
    expect(hidden(g.apexR) || hidden(s.ruizR)).toBe(false);
    expect(label.textContent).toBe('2 teams');
  });

  it("hides a team's joiners and leavers, empty change groups, its phone cards, and shows them again", () => {
    const { tick, g, s, lines, svg, cards } = setup();
    tick('t3', false);
    expect([g.voltL, g.voltR, g.joined, g.left, s.petrovL, s.lindR].every(hidden)).toBe(true);
    expect([lines.d2, lines.d3].every(hidden)).toBe(true);
    expect(lines.d1.getAttribute('d')).toBe('M0 8.5 C50 8.5 50 2.5 100 2.5');
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 11');
    expect([cards.volt, cards.left].every(hidden)).toBe(true);
    expect(hidden(cards.apex)).toBe(false);

    tick('t3', true);
    expect([g.voltL, g.joined, g.left, lines.d2, lines.d3, cards.volt, cards.left].some(hidden)).toBe(false);
    expect(lines.d2.getAttribute('d')).toBe('M0 25.5 C50 25.5 50 13.5 100 13.5');
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 28');
  });

  it('Select All unticks and ticks every team, and shows partly ticked in between', () => {
    const { all, boxes, tick, label, none, cardsNone, g } = setup();
    all.checked = false;
    all.dispatch('change');
    expect(boxes().some((b) => b.checked)).toBe(false);
    expect(Object.values(g).every(hidden)).toBe(true);
    expect([hidden(none), hidden(cardsNone)]).toEqual([false, false]);
    expect(label.textContent).toBe('0 teams');

    tick('t2', true);
    expect([all.checked, all.indeterminate]).toEqual([false, true]);
    expect(label.textContent).toBe('Redline');
    expect(hidden(none)).toBe(true);

    all.checked = true;
    all.dispatch('change');
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect([all.checked, all.indeterminate]).toEqual([true, false]);
    expect(Object.values(g).some(hidden)).toBe(false);
    expect(label.textContent).toBe('All teams');
  });

  it('narrows only the list when searching, never the board', () => {
    const { search, boxes, g } = setup();
    search.value = 'VO';
    search.dispatch('input');
    expect(boxes().map((b) => hidden(b.closest('label')!))).toEqual([true, true, false]);
    expect(Object.values(g).some(hidden)).toBe(false);
    expect(boxes().every((b) => b.checked)).toBe(true);
    search.value = '';
    search.dispatch('input');
    expect(boxes().some((b) => hidden(b.closest('label')!))).toBe(false);
  });

  it('opens on the toggle, stays open for clicks inside, and closes on Escape or an outside click', () => {
    const { toggle, panel, box } = setup();
    toggle.click();
    expect([hidden(panel), toggle.getAttribute('aria-expanded')]).toEqual([false, 'true']);
    box('t1').dispatch('click');
    expect(hidden(panel)).toBe(false);
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' } as never);
    expect([hidden(panel), toggle.getAttribute('aria-expanded')]).toEqual([true, 'false']);
    expect(doc.activeElement).toBe(toggle);
    toggle.click();
    doc.body.dispatch('click');
    expect(hidden(panel)).toBe(true);
  });

  it('clears a highlight whose move is filtered out', () => {
    const { board, s, tick } = setup();
    s.ruizR.dispatch('pointerover');
    expect(board.getAttribute('data-active-key')).toBe('d1');
    tick('t1', false);
    expect(board.hasAttribute('data-active-key')).toBe(false);
  });

  it('binds the controls and fills the list once, however often astro:page-load fires', () => {
    const ui = drawDropdown();
    const listen = vi.spyOn(ui.toggle, 'addEventListener');
    drawFragment();
    mod.initLineupBoards();
    mod.initLineupBoards();
    for (const fn of doc.listeners.get('astro:page-load') ?? []) fn({} as never);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(ui.list.querySelectorAll('[data-lineup-team-option]')).toHaveLength(3);
    ui.toggle.click();
    expect(hidden(ui.panel)).toBe(false);
  });

  it('words the toggle as All teams, the one name, or N teams', () => {
    expect(mod.teamToggleLabel(['a', 'b'], 2)).toBe('All teams');
    expect(mod.teamToggleLabel(['Volt GP'], 3)).toBe('Volt GP');
    expect(mod.teamToggleLabel(['a', 'b'], 3)).toBe('2 teams');
    expect(mod.teamToggleLabel([], 3)).toBe('0 teams');
  });
});
