/**
 * The Reported Incidents filter bar and inline clips (FR1.2, FR1.6, FR1.7; BR1.3, BR1.5). The server renders every
 * card with the first filter already applied, so this only switches filters without a reload, and builds a
 * card's clip player on desktop once the card is on screen. Cards hidden by a filter lose their player, so
 * nothing keeps playing out of sight. The fragment's own scripts never run, so this binds on astro:page-load.
 */
import { buildClipPlayer } from './videoPlayer';

/** A card or appeal in the list, as the filter sees it; tests pass small fakes. */
export interface FilterItem {
  group: string;
  setHidden(hidden: boolean): void;
  /** Empties a built inline player so a hidden card stops loading or playing. */
  clearPlayer(): void;
}

export interface FilterButton {
  filter: string;
  setPressed(pressed: boolean): void;
}

export interface FilterEmptyLine {
  filter: string;
  setHidden(hidden: boolean): void;
}

/** Shows `filter`'s items, hides the rest, presses its button and shows its empty line when it has none. */
export function applyFilter(
  filter: string,
  items: FilterItem[],
  buttons: FilterButton[],
  empties: FilterEmptyLine[],
): void {
  let shown = 0;
  for (const item of items) {
    const visible = item.group === filter;
    item.setHidden(!visible);
    if (visible) shown += 1;
    else item.clearPlayer();
  }
  for (const button of buttons) button.setPressed(button.filter === filter);
  for (const empty of empties) empty.setHidden(!(empty.filter === filter && shown === 0));
}

const DESKTOP = '(min-width: 1024px)';

function clearClip(slot: Element | null): void {
  if (slot instanceof HTMLElement && slot.dataset.built) {
    slot.replaceChildren();
    delete slot.dataset.built;
  }
}

function domItems(list: HTMLElement): FilterItem[] {
  return Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-filter-group]')).map((el) => ({
    group: el.dataset.filterGroup ?? '',
    setHidden: (hidden) => {
      el.hidden = hidden;
    },
    clearPlayer: () => el.querySelectorAll('[data-inline-clip]').forEach(clearClip),
  }));
}

function domButtons(bar: HTMLElement): FilterButton[] {
  return Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-incident-filter]')).map((btn) => ({
    filter: btn.dataset.incidentFilter ?? '',
    setPressed: (pressed) => {
      btn.setAttribute('aria-pressed', String(pressed));
      btn.classList.toggle('btn-active', pressed);
      btn.classList.toggle('btn-neutral', !pressed);
    },
  }));
}

function domEmpties(list: HTMLElement): FilterEmptyLine[] {
  return Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-filter-empty]')).map((el) => ({
    filter: el.dataset.filterEmpty ?? '',
    setHidden: (hidden) => {
      el.hidden = hidden;
    },
  }));
}

let clipObserver: IntersectionObserver | null = null;

/** Builds each inline clip the first time its card scrolls into view, on desktop only (BR1.5). */
function watchInlineClips(): void {
  clipObserver?.disconnect();
  clipObserver = null;
  if (!window.matchMedia(DESKTOP).matches || typeof IntersectionObserver === 'undefined') return;
  const slots = document.querySelectorAll<HTMLElement>('[data-inline-clip]');
  if (slots.length === 0) return;
  clipObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = entry.target as HTMLElement;
        if (!entry.isIntersecting || slot.dataset.built) continue;
        const player = buildClipPlayer(document, slot.dataset.inlineClip ?? '');
        if (!player) continue;
        slot.replaceChildren(player);
        slot.dataset.built = 'true';
      }
    },
    { rootMargin: '200px 0px' },
  );
  slots.forEach((slot) => clipObserver!.observe(slot));
}

function initIncidentFilters(): void {
  const bar = document.querySelector<HTMLElement>('[data-incident-filters]');
  const list = document.querySelector<HTMLElement>('[data-incident-list]');
  if (bar && list && !bar.dataset.filtersBound) {
    bar.dataset.filtersBound = 'true';
    bar.addEventListener('click', (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-incident-filter]');
      if (!button) return;
      applyFilter(button.dataset.incidentFilter ?? '', domItems(list), domButtons(bar), domEmpties(list));
    });
  }
  watchInlineClips();
}

// Guarded so the tests can import applyFilter in Node, where there is no document.
if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initIncidentFilters);
