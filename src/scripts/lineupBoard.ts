/**
 * The Lineup Changes board's highlight (BR1.22, NFR1.5): hovering or focusing a changed seat highlights its
 * seats and line and writes the move in the label line. The Teams filter hides unticked teams' rows, joiners,
 * leavers, lines and phone cards, then relays the rows out with the server's geometry (lib/lineups/geometry.ts)
 * so the lines still meet their seats; it is not saved, as a season change reloads. No fetches; the board
 * renders without this script. Imported by src/pages/advanced-stats.astro, and bound again when the fragment
 * loader re-dispatches astro:page-load after inserting the board.
 */
import { linePath, placeRows } from '../lib/lineups/geometry';

const FADED = 'opacity-30';
const ACTIVE = 'is-active';
// The Tailwind class, not the attribute: it beats the rows' own display classes (flex).
const HIDDEN = 'hidden';

/** The board-local key (d1, d2, ...) of the changed seat holding `target`, else null (stayers have none). */
export function activeKeyFor(target: EventTarget | null | undefined): string | null {
  const node = target as Element | null | undefined;
  if (!node || typeof node.closest !== 'function') return null;
  return node.closest('[data-seat][data-key]')?.getAttribute('data-key') ?? null;
}

/** Highlights `key`'s seats and line and shows its label; null clears the highlight and the label. */
export function applyHighlight(board: Element, key: string | null): void {
  if (key) board.setAttribute('data-active-key', key);
  else board.removeAttribute('data-active-key');

  let label = '';
  for (const seat of board.querySelectorAll('[data-seat][data-key]')) {
    const on = seat.getAttribute('data-key') === key;
    seat.classList.toggle(ACTIVE, on);
    seat.classList.toggle(FADED, key !== null && !on);
    if (on && !label) label = seat.getAttribute('data-label') ?? '';
  }
  for (const line of board.querySelectorAll('[data-line]')) {
    const on = line.getAttribute('data-line') === key;
    line.classList.toggle(ACTIVE, on);
    line.classList.toggle(FADED, key !== null && !on);
  }
  const text = board.querySelector('[data-lineup-label]');
  if (text) text.textContent = label;
}

/** Hides one column's filtered rows and returns each visible changed seat's new row centre, and the height. */
function relayoutColumn(column: Element, isHidden: (node: Element) => boolean) {
  const shown = [...column.querySelectorAll('[data-group]')].map((group) => {
    const groupHidden = isHidden(group);
    const visible = [...group.querySelectorAll('[data-seat]')].filter((seat) => {
      const off = groupHidden || isHidden(seat);
      seat.classList.toggle(HIDDEN, off);
      return !off;
    });
    group.classList.toggle(HIDDEN, visible.length === 0);
    return { heading: group.getAttribute('data-group') !== 'team', visible };
  });
  const placed = placeRows(shown.map((g) => ({ heading: g.heading, rows: g.visible.length })));
  const ys = new Map<string, number>();
  shown.forEach((g, i) =>
    g.visible.forEach((seat, j) => {
      const key = seat.getAttribute('data-key');
      if (key) ys.set(key, placed.centres[i][j]);
    }),
  );
  return { ys, height: placed.height };
}

/**
 * Shows only the teams not in `hidden` inside `root` (the fragment's [data-lineups] section): the board's
 * groups and seats, its lines and viewBox, the phone cards and the "No teams selected." lines. Seats with no
 * team key are never hidden.
 */
export function relayoutBoard(root: Element, hidden: ReadonlySet<string>): void {
  const isHidden = (node: Element) => hidden.has(node.getAttribute('data-team') ?? '');
  const board = root.querySelector('[data-lineup-board]');
  if (board) {
    const columns = [...board.querySelectorAll('[data-lineup-column]')].map((c) =>
      relayoutColumn(c, isHidden),
    );
    const [left, right] = columns;
    for (const line of board.querySelectorAll('[data-line]')) {
      const key = line.getAttribute('data-line') ?? '';
      const y1 = left?.ys.get(key);
      const y2 = right?.ys.get(key);
      line.classList.toggle(HIDDEN, y1 === undefined || y2 === undefined);
      if (y1 !== undefined && y2 !== undefined) line.setAttribute('d', linePath({ y1, y2 }));
    }
    const height = Math.max(0, ...columns.map((c) => c.height));
    board.querySelector('[data-lineup-lines]')?.setAttribute('viewBox', `0 0 100 ${height}`);
    // The highlight is about a move; once either end is filtered out, it no longer shows.
    const active = board.getAttribute('data-active-key');
    const activeLine = active ? board.querySelector(`[data-line="${active}"]`) : null;
    if (active && (!activeLine || activeLine.classList.contains(HIDDEN))) applyHighlight(board, null);
  }

  for (const node of root.querySelectorAll('[data-lineup-cards] [data-team]'))
    node.classList.toggle(HIDDEN, isHidden(node));
  const leftCard = root.querySelector('[data-lineup-left-card]');
  if (leftCard) leftCard.classList.toggle(HIDDEN, [...leftCard.querySelectorAll('li')].every(isHidden));

  const teams = [...root.querySelectorAll('[data-lineup-teams] [data-team]')];
  const none = teams.length > 0 && teams.every(isHidden);
  for (const line of root.querySelectorAll('[data-lineup-none]')) line.classList.toggle(HIDDEN, !none);
}

function bindBoard(board: Element): void {
  board.setAttribute('data-bound', '');
  const enter = (event: Event) => {
    const key = activeKeyFor(event.target);
    if (key) applyHighlight(board, key);
  };
  // Leaving for another changed seat is handled by its own enter event; anything else clears.
  const leave = (event: Event) => {
    const next = (event as PointerEvent | FocusEvent).relatedTarget as Element | null;
    const nextKey = next && board.contains(next) ? activeKeyFor(next) : null;
    if (!nextKey) applyHighlight(board, null);
  };
  board.addEventListener('pointerover', enter);
  board.addEventListener('focusin', enter);
  board.addEventListener('pointerout', leave);
  board.addEventListener('focusout', leave);
}

interface TeamControls {
  dropdown: HTMLElement;
  toggle: HTMLButtonElement;
  label: HTMLElement;
  panel: HTMLElement;
  search: HTMLInputElement;
  all: HTMLInputElement;
  list: HTMLElement;
}

/** The fragment section the Teams filter acts on, and the shell's controls; one of each per page. */
let current: { root: Element; controls: TeamControls } | null = null;
let documentBound = false;

function teamControls(): TeamControls | null {
  const dropdown = document.querySelector<HTMLElement>('[data-lineup-team-dropdown]');
  const find = <T extends Element>(attr: string) => dropdown?.querySelector<T>(`[${attr}]`) ?? null;
  const toggle = find<HTMLButtonElement>('data-lineup-team-toggle');
  const label = find<HTMLElement>('data-lineup-team-label');
  const panel = find<HTMLElement>('data-lineup-team-panel');
  const search = find<HTMLInputElement>('data-lineup-team-search');
  const all = find<HTMLInputElement>('data-lineup-team-all');
  const list = find<HTMLElement>('data-lineup-team-list');
  if (!dropdown || !toggle || !label || !panel || !search || !all || !list) return null;
  return { dropdown, toggle, label, panel, search, all, list };
}

const teamBoxes = (controls: TeamControls) => [
  ...controls.list.querySelectorAll<HTMLInputElement>('[data-lineup-team-option]'),
];

/** "All teams", the one team's name, or "N teams". */
export function teamToggleLabel(checkedNames: readonly string[], total: number): string {
  if (checkedNames.length === total) return 'All teams';
  if (checkedNames.length === 1) return checkedNames[0];
  return `${checkedNames.length} teams`;
}

function applyTeamFilter(): void {
  if (!current) return;
  const { root, controls } = current;
  const boxes = teamBoxes(controls);
  const checked = boxes.filter((box) => box.checked);
  controls.all.checked = checked.length === boxes.length;
  controls.all.indeterminate = checked.length > 0 && checked.length < boxes.length;
  controls.label.textContent = teamToggleLabel(
    checked.map((box) => box.closest('label')?.textContent?.trim() ?? ''),
    boxes.length,
  );
  relayoutBoard(root, new Set(boxes.filter((box) => !box.checked).map((box) => box.value)));
}

function setPanelOpen(controls: TeamControls, open: boolean): void {
  controls.panel.classList.toggle(HIDDEN, !open);
  controls.toggle.setAttribute('aria-expanded', String(open));
}

function teamRow(key: string, name: string): HTMLLabelElement {
  const row = document.createElement('label');
  row.className =
    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-white/80 hover:bg-white/10';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = true;
  box.value = key;
  box.setAttribute('data-lineup-team-option', '');
  row.append(box, name);
  return row;
}

function bindControls(controls: TeamControls): void {
  controls.dropdown.setAttribute('data-bound', '');
  controls.toggle.addEventListener('click', () =>
    setPanelOpen(controls, controls.panel.classList.contains(HIDDEN)),
  );
  controls.list.addEventListener('change', applyTeamFilter);
  controls.all.addEventListener('change', () => {
    for (const box of teamBoxes(controls)) box.checked = controls.all.checked;
    applyTeamFilter();
  });
  // Search narrows only the list of checkboxes, never the board.
  controls.search.addEventListener('input', () => {
    const query = controls.search.value.trim().toLowerCase();
    for (const box of teamBoxes(controls)) {
      const row = box.closest('label');
      row?.classList.toggle(HIDDEN, !(row.textContent ?? '').toLowerCase().includes(query));
    }
  });
}

function bindDocument(): void {
  documentBound = true;
  document.addEventListener('click', (event) => {
    const controls = current?.controls;
    if (!controls || controls.panel.classList.contains(HIDDEN)) return;
    if (!controls.dropdown.contains(event.target as Node)) setPanelOpen(controls, false);
  });
  document.addEventListener('keydown', (event) => {
    const controls = current?.controls;
    if ((event as KeyboardEvent).key !== 'Escape' || !controls || controls.panel.classList.contains(HIDDEN))
      return;
    setPanelOpen(controls, false);
    controls.toggle.focus();
  });
}

/** Fills the Teams list from a newly loaded board and enables the toggle; a message leaves it disabled. */
function bindFilter(root: Element): void {
  root.setAttribute('data-filter-bound', '');
  const teams = [...root.querySelectorAll('[data-lineup-teams] [data-team]')].map((node) => ({
    key: node.getAttribute('data-team') ?? '',
    name: node.textContent?.trim() ?? '',
  }));
  const controls = teamControls();
  if (!controls || teams.length === 0) return;
  if (!controls.dropdown.hasAttribute('data-bound')) bindControls(controls);
  if (!documentBound) bindDocument();
  current = { root, controls };
  controls.list.replaceChildren(...teams.map((t) => teamRow(t.key, t.name)));
  controls.search.value = '';
  controls.toggle.disabled = false;
  applyTeamFilter();
}

/** Binds every board and fragment not yet bound, once each. */
export function initLineupBoards(): void {
  document.querySelectorAll('[data-lineup-board]:not([data-bound])').forEach(bindBoard);
  document.querySelectorAll('[data-lineups]:not([data-filter-bound])').forEach(bindFilter);
}

if (typeof document !== 'undefined') {
  initLineupBoards();
  document.addEventListener('astro:page-load', initLineupBoards);
}
