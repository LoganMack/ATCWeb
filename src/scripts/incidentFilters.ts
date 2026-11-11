/**
 * The Reported Incidents filter bar (FR1.2, FR1.7; BR1.3). The server renders every card with the first filter
 * already applied, so this only switches filters without a reload. Videos are thumbnails that open the popup
 * player (components/ClipThumbnail.astro); a still image that fails to load falls back to the plain tile. The
 * fragment's own scripts never run, so this binds on astro:page-load.
 */

/** A card or appeal in the list, as the filter sees it; tests pass small fakes. */
export interface FilterItem {
  group: string;
  setHidden(hidden: boolean): void;
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
  }
  for (const button of buttons) button.setPressed(button.filter === filter);
  for (const empty of empties) empty.setHidden(!(empty.filter === filter && shown === 0));
}

function domItems(list: HTMLElement): FilterItem[] {
  return Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-filter-group]')).map((el) => ({
    group: el.dataset.filterGroup ?? '',
    setHidden: (hidden) => {
      el.hidden = hidden;
    },
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

/** A thumbnail's still image that failed drops out, leaving the tile and its play symbol. */
function dropBrokenStill(img: HTMLImageElement): void {
  img.remove();
}

function watchClipStills(): void {
  document.querySelectorAll<HTMLImageElement>('img[data-clip-still]').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) dropBrokenStill(img);
    else img.addEventListener('error', () => dropBrokenStill(img), { once: true });
  });
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
  watchClipStills();
}

// Guarded so the tests can import applyFilter in Node, where there is no document.
if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initIncidentFilters);
