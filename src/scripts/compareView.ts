/**
 * Advanced Stats Compare view (FR4, BR4.1-BR4.12; the Timing tower redesign FR2-FR5): four slots, each
 * holding a driver, team or car from the fragment's embedded lists, and ten stat rows, each with a Total and
 * a Percent and their own leaders, recomputed on every change. The picks live in the address (`a`-`d`) and
 * are written with history.replaceState; the Class, View and Season selects (data-compare-nav) carry them to
 * the new address. Names are set as text, never as HTML. The layout itself is src/scripts/compareTower.ts.
 */
import {
  COMPARE_ROWS,
  DASH,
  edgeColours,
  filterPickerEntries,
  formatPercentValue,
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
import {
  el,
  emptySlotHeader,
  filledSlotHeader,
  towerElement,
  type CompareCellView,
  type CompareRowView,
} from './compareTower';

export type { CompareCellView, CompareRowView, CompareValueView } from './compareTower';

const SLOT_COUNT = SLOT_PARAMS.length;

/**
 * What a screen reader hears for one filled value (FR2.3), for example "Wins, Ann Able: 12, leader; 24.0% of
 * starts". A dashed Total is "none", a dashed Percent "no rate", and a blank Percent is left out.
 */
export function cellLabel(
  row: Pick<CompareRowView, 'label' | 'denominator'>,
  entityName: string,
  cell: Pick<CompareCellView, 'total' | 'percent'>,
): string {
  const total = cell.total.text === DASH ? 'none' : cell.total.text;
  let text = `${row.label}, ${entityName}: ${total}${cell.total.leader ? ', leader' : ''}`;
  if (cell.percent) {
    const of = row.denominator.replace(/^%\s*/, '');
    const rate = cell.percent.text === DASH ? 'no rate' : `${cell.percent.text}${of ? ` ${of}` : ''}`;
    text += `; ${rate}${cell.percent.leader ? ', leader' : ''}`;
  }
  return text;
}

/**
 * The ten rows for the slots' entities (FR3, FR4): each value's text, the Total leaders and the Percent
 * leaders worked out separately, and the tab edge from the Total leaders. An empty slot shows nothing.
 */
export function compareRowViews(slots: (CompareEntity | null)[], races: number): CompareRowView[] {
  const ctx = { races };
  return COMPARE_ROWS.map((row) => {
    const totals = slots.map((e) => (e ? row.total.value(e) : null));
    const percents = slots.map((e) => (e ? row.percent(e, ctx) : undefined));
    const totalLeaders = rowLeaders(totals).leaders;
    const percentLeaders = rowLeaders(percents).leaders;
    const view: CompareRowView = {
      key: row.key,
      label: row.label,
      denominator: row.denominator,
      edge: edgeColours(totalLeaders),
      cells: [],
    };
    view.cells = slots.map((e, i) => {
      if (!e) return { empty: true, total: { text: '', leader: false }, percent: null, srText: '' };
      const percent = percents[i];
      const cell = {
        empty: false,
        total: { text: row.total.format(e), leader: totalLeaders[i] },
        percent:
          percent === undefined ? null : { text: formatPercentValue(percent), leader: percentLeaders[i] },
      };
      return { ...cell, srText: cellLabel(view, e.name, cell) };
    });
    return view;
  });
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

/**
 * The embedded lists, or null when the fragment has not arrived or holds no data. A fragment cached from
 * before `races` existed reads as 0 races, so its Starts % shows a dash rather than a wrong figure.
 */
export function parseCompareData(text: string | null | undefined): CompareData | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as CompareData;
    if (!Array.isArray(data.drivers) || !Array.isArray(data.teams) || !Array.isArray(data.cars)) return null;
    return { ...data, races: typeof data.races === 'number' ? data.races : 0 };
  } catch (err) {
    console.error('Compare view: could not read the embedded data:', err);
    return null;
  }
}

// --- DOM ---

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

/** The EntityPicker combobox (BR4.11): type to filter, arrows to move, Enter to pick, Escape to close. */
function picker(state: ViewState, slot: number): HTMLElement {
  // Not positioned on phones, so the list spans the header row rather than this narrow column.
  const wrap = el('div', { class: 'min-w-0 sm:relative' });
  const listId = `compare-list-${slot}`;
  const label = el(
    'label',
    {
      for: `compare-input-${slot}`,
      class: 'text-[0.625rem] font-semibold uppercase tracking-wide text-white/70 sm:text-xs',
    },
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
      'search-input mt-1 h-8 w-full min-w-0 rounded-md border border-white/15 bg-transparent px-1 text-[0.6875rem] text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5 sm:mt-1.5 sm:h-9 sm:px-3 sm:text-sm',
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

function render(state: ViewState): void {
  const target = state.root.querySelector<HTMLElement>('[data-compare-slots]');
  if (!target) return;
  const slots = resolvePicks(state.data, state.picks);
  const headers = slots.map((entity, slot) =>
    entity
      ? filledSlotHeader(slot, entity, () => setPick(state, slot, null, 'input'))
      : emptySlotHeader(slot, picker(state, slot)),
  );
  target.replaceChildren(towerElement(compareRowViews(slots, state.data.races), headers));
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
