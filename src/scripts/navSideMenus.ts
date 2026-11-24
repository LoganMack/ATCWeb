/**
 * The desktop nav's side menus (nav-side-menus BR1.7-BR1.11): the keyboard and click opening, moving and
 * closing, and the flip to the left at the window edge. Hover opening is CSS only (`group-hover/side`), so a
 * side menu still opens under the pointer if this script never runs. Listeners are delegated on the document
 * and bound once, so they survive Astro page swaps.
 */

export type SideMenuZone = 'parent' | 'toggle' | 'item';
export type SideMenuAction = 'open' | 'next' | 'prev' | 'first' | 'last' | 'close';

const ROW = '[data-nav-side]';
const PARENT = '[data-nav-side-parent]';
const TOGGLE = '[data-nav-side-toggle]';
const PANEL = '[data-nav-side-panel]';
const LINK = '[data-nav-side-link]';

/** How far from the window's right edge a panel may reach before it opens to the left instead. */
export const FLIP_MARGIN = 8;

/** The keyboard table in frontend-components.md; null leaves the key to the browser. */
export function sideMenuKeyAction(key: string, zone: SideMenuZone): SideMenuAction | null {
  if (zone !== 'item') return key === 'ArrowRight' ? 'open' : null;
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Escape':
    case 'ArrowLeft':
      return 'close';
    default:
      return null;
  }
}

/** True when the unflipped panel would pass the window's right edge (BR1.11). */
export function shouldFlip(right: number, width: number): boolean {
  return right > width - FLIP_MARGIN;
}

/** The side-menu row an event happened in, if any; text and non-element targets have no `closest`. */
function rowOf(target: EventTarget | null): HTMLElement | null {
  return (target as Element | null)?.closest?.<HTMLElement>(ROW) ?? null;
}

function zoneOf(target: Element): SideMenuZone | null {
  if (target.closest(LINK)) return 'item';
  if (target.closest(TOGGLE)) return 'toggle';
  if (target.closest(PARENT)) return 'parent';
  return null;
}

function linksOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>(LINK));
}

function toggleOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(TOGGLE);
}

/** Measures the panel unflipped (it has a box even while invisible) and flips it if it would not fit. */
function place(row: HTMLElement, doc: Document): void {
  const panel = row.querySelector<HTMLElement>(PANEL);
  row.removeAttribute('data-flip');
  const width = doc.documentElement?.clientWidth ?? 0;
  if (!panel || !width) return;
  if (shouldFlip(panel.getBoundingClientRect().right, width)) row.setAttribute('data-flip', '');
}

function focusFirst(row: HTMLElement, doc: Document): void {
  const first = linksOf(row)[0];
  if (!first) return;
  first.focus();
  // The panel's visibility transition can leave it hidden for this frame; try again once it has started.
  if (doc.activeElement !== first && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (row.hasAttribute('data-open')) first.focus();
    });
  }
}

function close(row: HTMLElement, opts: { dismiss?: boolean; returnFocus?: boolean } = {}): void {
  row.removeAttribute('data-open');
  const toggle = toggleOf(row);
  toggle?.setAttribute('aria-expanded', 'false');
  // Keeps the panel hidden under the pointer until it leaves the row, so Escape always dismisses (WCAG 1.4.13).
  if (opts.dismiss) row.setAttribute('data-dismissed', '');
  if (opts.returnFocus) toggle?.focus();
}

function open(row: HTMLElement, doc: Document): void {
  for (const other of Array.from(doc.querySelectorAll<HTMLElement>(`${ROW}[data-open]`))) {
    if (other !== row) close(other);
  }
  place(row, doc);
  row.removeAttribute('data-dismissed');
  row.setAttribute('data-open', '');
  toggleOf(row)?.setAttribute('aria-expanded', 'true');
  focusFirst(row, doc);
}

function move(row: HTMLElement, from: Element, action: 'next' | 'prev' | 'first' | 'last'): void {
  const links = linksOf(row);
  if (links.length === 0) return;
  const at = links.indexOf(from.closest<HTMLElement>(LINK)!);
  const last = links.length - 1;
  const to =
    action === 'first'
      ? 0
      : action === 'last'
        ? last
        : action === 'next'
          ? at >= last
            ? 0
            : at + 1
          : at <= 0
            ? last
            : at - 1;
  links[to].focus();
}

function onKeydown(event: KeyboardEvent, doc: Document): void {
  const row = rowOf(event.target);
  if (!row) return;
  const target = event.target as Element;
  const zone = zoneOf(target);
  const action = zone ? sideMenuKeyAction(event.key, zone) : null;
  if (!action) return;
  event.preventDefault();
  if (action === 'open') open(row, doc);
  else if (action === 'close') close(row, { dismiss: true, returnFocus: true });
  else move(row, target, action);
}

/** Enter, Space and the mouse all arrive here: open with focus inside, or close with focus kept (BR1.7). */
function onClick(event: MouseEvent, doc: Document): void {
  const toggle = (event.target as Element | null)?.closest?.<HTMLElement>(TOGGLE);
  const row = toggle ? rowOf(toggle) : null;
  if (!row) return;
  // Dismiss too, so a panel first opened by hover doesn't stay visible under the pointer once closed.
  if (row.hasAttribute('data-open')) close(row, { dismiss: true });
  else open(row, doc);
}

function leavesRow(row: HTMLElement, related: EventTarget | null): boolean {
  return !related || !row.contains(related as Node);
}

function onFocusout(event: FocusEvent): void {
  const row = rowOf(event.target);
  if (row?.hasAttribute('data-open') && leavesRow(row, event.relatedTarget)) close(row);
}

function onMouseover(event: MouseEvent, doc: Document): void {
  const row = rowOf(event.target);
  if (!row || !leavesRow(row, event.relatedTarget)) return;
  // A fresh entry ends any keyboard dismissal made while the pointer was elsewhere.
  row.removeAttribute('data-dismissed');
  place(row, doc);
}

function onMouseout(event: MouseEvent): void {
  const row = rowOf(event.target);
  if (row && leavesRow(row, event.relatedTarget)) row.removeAttribute('data-dismissed');
}

// Per document rather than one boolean, so each test's fresh fake document binds its own listeners.
const boundDocuments = new WeakSet<object>();

export function initNavSideMenus(doc: Document): void {
  if (boundDocuments.has(doc)) return;
  boundDocuments.add(doc);
  doc.addEventListener('keydown', (e) => onKeydown(e, doc));
  doc.addEventListener('click', (e) => onClick(e, doc));
  doc.addEventListener('focusout', onFocusout);
  doc.addEventListener('mouseover', (e) => onMouseover(e, doc));
  doc.addEventListener('mouseout', onMouseout);
}

// Guarded so the tests can import the helpers in Node, where there is no document.
if (typeof document !== 'undefined')
  document.addEventListener('astro:page-load', () => initNavSideMenus(document));
