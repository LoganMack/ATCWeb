/**
 * The Lineup Changes board's highlight (U9, BR1.22, NFR1.5): hovering or focusing a changed driver's seat, in
 * either column, highlights its two seats and its line, fades the other changes and writes the move as text in
 * the label line. No data work and no fetches; the board and its lines render without this script.
 * Imported by src/pages/advanced-stats.astro, and bound again when the fragment loader re-dispatches
 * astro:page-load after inserting the board.
 */

const FADED = 'opacity-30';
const ACTIVE = 'is-active';

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

/** Binds every board not yet bound, once each. */
export function initLineupBoards(): void {
  document.querySelectorAll('[data-lineup-board]:not([data-bound])').forEach(bindBoard);
}

if (typeof document !== 'undefined') {
  initLineupBoards();
  document.addEventListener('astro:page-load', initLineupBoards);
}
