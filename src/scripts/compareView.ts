/**
 * Advanced Stats Compare view (FR4, BR4.1-BR4.12): four slots, each holding a driver, team or car from the
 * fragment's embedded lists, and twelve stat rows with leaders and bars recomputed on every change. The picks
 * live in the address (`a`-`d`) and are written with history.replaceState; the Class, View and Season selects
 * (data-compare-nav) carry them to the new address. Names are set as text, never as HTML.
 */
import {
  COMPARE_ROWS,
  DASH,
  filterPickerEntries,
  pickParams,
  readPicks,
  resolvePicks,
  rowLeaders,
  SLOT_PARAMS,
  writePicks,
  type CompareData,
  type CompareEntity,
  type PickerGroup,
} from '../lib/compareRows';

const SLOT_COUNT = SLOT_PARAMS.length;
const TYPE_LABEL: Record<CompareEntity['type'], string> = { driver: 'Driver', team: 'Team', car: 'Car' };

export interface CompareCellView {
  text: string;
  leader: boolean;
  /** Bar width in percent of the row's best; 0 for an empty slot. */
  width: number;
  empty: boolean;
}

export interface CompareRowView {
  key: string;
  label: string;
  cells: CompareCellView[];
}

/** The twelve rows for the slots' entities, with leaders and bars (BR4.10); an empty slot shows nothing. */
export function compareRowViews(slots: (CompareEntity | null)[]): CompareRowView[] {
  return COMPARE_ROWS.map((row) => {
    const values = slots.map((e) => (e ? row.value(e) : null));
    const { leaders, widths } = rowLeaders(values);
    return {
      key: row.key,
      label: row.label,
      cells: slots.map((e, i) => ({
        text: e ? row.format(e) : '',
        leader: leaders[i],
        width: widths[i],
        empty: e === null,
      })),
    };
  });
}

/**
 * What a screen reader hears for one filled stat cell, naming whose value it is (BR4.12), for example
 * "Wins, Ann Able: 12, leader". A dash is read as "none".
 */
export function cellLabel(rowLabel: string, entityName: string, cell: CompareCellView): string {
  const value = cell.text === DASH ? 'none' : cell.text;
  return `${rowLabel}, ${entityName}: ${value}${cell.leader ? ', leader' : ''}`;
}

/** One item of the Compare grid: a slot card, a stat label or one slot's stat cell. */
export interface CompareGridItem {
  kind: 'slot' | 'label' | 'cell';
  /** The slot of a card or cell; null for a label. */
  slot: number | null;
  /** The index into COMPARE_ROWS of a label or cell; null for a card. */
  row: number | null;
  /** The item's place from `sm` up, where the grid reads four slots across and each stat row across all four. */
  wideOrder: number;
  /** A stat label repeated for the second pair of slots: shown on phones only. */
  phoneOnly: boolean;
}

/**
 * The Compare grid's items (BR4.12). The document order is the phone layout: slots 1-2 as a pair with their
 * stat rows under them, then slots 3-4 with theirs, so every value sits below its own name. From `sm` up the
 * CSS `order` (wideOrder) lays the same items out as four columns: the slot cards in one row, then each stat
 * label once with its four cells.
 */
export function compareGridItems(slotCount: number, rowCount: number): CompareGridItem[] {
  const items: CompareGridItem[] = [];
  const stride = slotCount + 1; // a label and one cell per slot
  for (let first = 0; first < slotCount; first += 2) {
    const pair = [first, first + 1].filter((s) => s < slotCount);
    for (const slot of pair) items.push({ kind: 'slot', slot, row: null, wideOrder: slot, phoneOnly: false });
    for (let row = 0; row < rowCount; row++) {
      const base = slotCount + row * stride;
      items.push({ kind: 'label', slot: null, row, wideOrder: base, phoneOnly: first > 0 });
      for (const slot of pair) {
        items.push({ kind: 'cell', slot, row, wideOrder: base + 1 + slot, phoneOnly: false });
      }
    }
  }
  return items;
}

/** The picker's next highlighted option for a key press, wrapping at both ends; -1 means none. */
export function nextActiveIndex(current: number, count: number, key: string): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 || current >= count - 1 ? 0 : current + 1;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  return current;
}

/** A Class, View or Season option's address with the current picks carried over. */
export function addressWithPicks(href: string, search: string): string {
  const picks = pickParams(search);
  if (!picks) return href;
  return `${href}${href.includes('?') ? '&' : '?'}${picks}`;
}

/** The embedded lists, or null when the fragment has not arrived or holds no data. */
export function parseCompareData(text: string | null | undefined): CompareData | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as CompareData;
    if (!Array.isArray(data.drivers) || !Array.isArray(data.teams) || !Array.isArray(data.cars)) return null;
    return data;
  } catch (err) {
    console.error('Compare view: could not read the embedded data:', err);
    return null;
  }
}

// --- DOM ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

interface ViewState {
  data: CompareData;
  picks: (string | null)[];
  root: HTMLElement;
}

function setPick(state: ViewState, slot: number, key: string | null, focus: 'clear' | 'input'): void {
  state.picks[slot] = key;
  history.replaceState(history.state, '', `${location.pathname}${writePicks(location.search, state.picks)}`);
  render(state);
  const target =
    focus === 'clear'
      ? state.root.querySelector<HTMLElement>(`[data-compare-clear="${slot}"]`)
      : state.root.querySelector<HTMLElement>(`[data-compare-input="${slot}"]`);
  target?.focus();
}

function slotCard(state: ViewState, slot: number, entity: CompareEntity | null): HTMLElement {
  const card = el('div', {
    class: 'flex min-h-[9rem] flex-col gap-3 rounded-xl border border-white/10 bg-brand-ink p-3',
    'data-compare-slot': String(slot),
  });
  if (!entity) {
    card.append(picker(state, slot));
    return card;
  }

  const head = el('div', { class: 'flex items-start gap-3' });
  if (entity.imageUrl) {
    head.append(
      el('img', {
        src: entity.imageUrl,
        alt: '',
        class: 'h-12 w-12 shrink-0 rounded-md object-cover',
        loading: 'lazy',
        decoding: 'async',
      }),
    );
  }
  const names = el('div', { class: 'min-w-0 flex-1' });
  names.append(el('p', { class: 'text-xs uppercase tracking-wide text-white/40' }, TYPE_LABEL[entity.type]));
  if (entity.href) {
    const link = el('a', {
      href: entity.href,
      class: 'font-display text-xl leading-tight hover:text-brand-primary',
    });
    link.textContent = entity.name;
    names.append(link);
  } else {
    names.append(el('p', { class: 'font-display text-xl leading-tight' }, entity.name));
  }
  head.append(names);
  card.append(head);

  const clear = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-neutral self-start',
      'aria-label': `Clear slot ${slot + 1}`,
      'data-compare-clear': String(slot),
    },
    'Clear',
  );
  clear.addEventListener('click', () => setPick(state, slot, null, 'input'));
  card.append(clear);
  return card;
}

/** The EntityPicker combobox (BR4.11): type to filter, arrows to move, Enter to pick, Escape to close. */
function picker(state: ViewState, slot: number): HTMLElement {
  const wrap = el('div', { class: 'relative' });
  const listId = `compare-list-${slot}`;
  const label = el(
    'label',
    { for: `compare-input-${slot}`, class: 'text-xs font-semibold uppercase tracking-wide text-white/40' },
    `Slot ${slot + 1}`,
  );
  const input = el('input', {
    id: `compare-input-${slot}`,
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    placeholder: 'Pick a driver, team or car…',
    class:
      'search-input mt-1.5 h-9 w-full rounded-md border border-white/15 bg-transparent px-3 text-sm text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5',
    'data-compare-input': String(slot),
  });
  const list = el('ul', {
    id: listId,
    role: 'listbox',
    'aria-label': `Choices for slot ${slot + 1}`,
    class:
      'absolute left-0 right-0 z-40 mt-1 hidden max-h-72 overflow-auto rounded-md border border-white/15 bg-brand-ink py-1 text-sm shadow-lg',
  });
  wrap.append(label, input, list);

  let options: { li: HTMLLIElement; key: string }[] = [];
  let active = -1;

  const close = () => {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (index: number) => {
    active = index;
    options.forEach((o, i) => {
      const on = i === index;
      o.li.setAttribute('aria-selected', on ? 'true' : 'false');
      o.li.classList.toggle('bg-white/10', on);
    });
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', options[index].li.id);
      options[index].li.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const open = () => {
    const groups: PickerGroup[] = filterPickerEntries(state.data, input.value);
    list.replaceChildren();
    options = [];
    if (groups.length === 0) {
      list.append(el('li', { role: 'presentation', class: 'px-3 py-2 text-white/50' }, 'No matches'));
    }
    for (const group of groups) {
      const headingId = `${listId}-${group.type}`;
      const groupEl = el('li', { role: 'presentation' });
      const inner = el('ul', { role: 'group', 'aria-labelledby': headingId });
      groupEl.append(
        el(
          'p',
          {
            id: headingId,
            class: 'px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-white/40',
          },
          group.label,
        ),
        inner,
      );
      for (const item of group.items) {
        const li = el(
          'li',
          {
            id: `${listId}-${options.length}`,
            role: 'option',
            'aria-selected': 'false',
            class: 'cursor-pointer px-3 py-1.5 hover:bg-white/10',
          },
          item.name,
        );
        // mousedown, not click, so the pick lands before the input's blur closes the list.
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          setPick(state, slot, item.key, 'clear');
        });
        inner.append(li);
        options.push({ li, key: item.key });
      }
      if (group.more > 0) {
        inner.append(
          el(
            'li',
            { role: 'presentation', class: 'px-3 py-1 text-xs text-white/40' },
            `${group.more.toLocaleString('en-US')} more match — keep typing`,
          ),
        );
      }
      list.append(groupEl);
    }
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.classList.contains('hidden')) open();
      highlight(nextActiveIndex(active, options.length, e.key));
    } else if (e.key === 'Enter') {
      if (active >= 0 && options[active]) {
        e.preventDefault();
        setPick(state, slot, options[active].key, 'clear');
      }
    } else if (e.key === 'Escape') {
      if (!list.classList.contains('hidden')) {
        e.preventDefault();
        close();
      }
    }
  });
  return wrap;
}

/** One slot's value and bar for one stat row, named for screen readers; an empty slot is a hidden dot. */
function statCell(rowLabel: string, entity: CompareEntity | null, cell: CompareCellView): HTMLElement {
  const box = el('div', { class: 'min-w-0' });
  if (!entity || cell.empty) {
    box.setAttribute('aria-hidden', 'true');
    box.append(el('span', { class: 'text-sm text-white/20' }, '·'));
    return box;
  }
  box.append(el('span', { class: 'sr-only' }, cellLabel(rowLabel, entity.name, cell)));
  box.append(
    el(
      'span',
      {
        class: cell.leader ? 'text-sm font-bold text-brand-primary' : 'text-sm text-white/80',
        'aria-hidden': 'true',
      },
      cell.text,
    ),
  );
  if (cell.leader) box.dataset.leader = 'true';
  const track = el('div', { class: 'mt-1 h-1.5 w-full rounded-full bg-white/5', 'aria-hidden': 'true' });
  // A solid brand fill takes fixed white text in both themes, as everywhere else on the site.
  const bar = el('div', { class: 'h-full rounded-full bg-brand-primary text-fixed-white' });
  bar.style.width = `${cell.width.toFixed(1)}%`;
  track.append(bar);
  box.append(track);
  return box;
}

/** Places an item from `sm` up (compareGridItems' wideOrder) through a custom property, one static class. */
function placeWide(node: HTMLElement, item: CompareGridItem): HTMLElement {
  node.style.setProperty('--wide-order', String(item.wideOrder));
  node.classList.add('sm:order-[var(--wide-order)]');
  return node;
}

function render(state: ViewState): void {
  const target = state.root.querySelector<HTMLElement>('[data-compare-slots]');
  if (!target) return;
  const slots = resolvePicks(state.data, state.picks);
  const rows = compareRowViews(slots);
  const grid = el('div', {
    class: 'grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4',
    'data-compare-grid': '',
  });
  for (const item of compareGridItems(slots.length, rows.length)) {
    let node: HTMLElement;
    if (item.kind === 'slot') {
      node = slotCard(state, item.slot!, slots[item.slot!]);
      node.classList.add('mb-3');
      // The second pair starts its own block on phones.
      if (item.slot! >= 2) node.classList.add('mt-6', 'sm:mt-0');
    } else if (item.kind === 'label') {
      const row = rows[item.row!];
      // Every cell's own name repeats the stat, so the visual label is not read out a second time.
      node = el(
        'p',
        {
          class: 'col-span-2 pt-3 text-xs font-semibold uppercase tracking-wide text-white/40 sm:col-span-4',
          'aria-hidden': 'true',
          'data-compare-row': row.key,
        },
        row.label,
      );
      if (item.phoneOnly) node.classList.add('sm:hidden');
    } else {
      const row = rows[item.row!];
      node = statCell(row.label, slots[item.slot!], row.cells[item.slot!]);
      node.dataset.compareCell = String(item.slot);
    }
    grid.append(placeWide(node, item));
  }
  target.replaceChildren(grid);
}

function initCompareView(): void {
  const root = document.querySelector<HTMLElement>('[data-compare-view] [data-compare-root]');
  if (!root || root.dataset.compareBound) return;
  const data = parseCompareData(root.querySelector('#compare-data')?.textContent);
  if (!data) return;
  root.dataset.compareBound = 'true';
  // An unknown or stale key leaves its slot empty (BR4.4), but stays in the address until replaced.
  const picks = readPicks(location.search).slice(0, SLOT_COUNT);
  render({ data, picks, root });
}

let navBound = false;

function bindCompareNav(): void {
  if (navBound) return;
  navBound = true;
  document.addEventListener('change', (e) => {
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-compare-nav]');
    if (!select) return;
    location.assign(addressWithPicks(select.value, location.search));
  });
}

if (typeof document !== 'undefined') {
  bindCompareNav();
  initCompareView();
  document.addEventListener('astro:page-load', initCompareView);
}
