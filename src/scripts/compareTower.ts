/**
 * The Compare view's Timing tower layout (FR2, FR4, FR5.5, NFR1-NFR3): a header row of four slot blocks, then
 * ten stat rows, each a stat tab (the label once, with its Percent's denominator) and one Total and Percent
 * per slot. The tab's left edge takes the slot colour of the row's Total leader. Built from the row views
 * src/scripts/compareView.ts computes; the visual figures are aria-hidden and each value carries one hidden
 * text instead. Colours come only from theme tokens, so both themes work.
 */
import { DASH, SLOT_COLOURS, type CompareEntity, type SlotColour } from '../lib/compareRows';

/** One Total or Percent as shown. */
export interface CompareValueView {
  /** The figure, or a dash. */
  text: string;
  leader: boolean;
}

export interface CompareCellView {
  /** An empty slot shows no values (FR5.5). */
  empty: boolean;
  total: CompareValueView;
  /** Null leaves the Percent space blank (Corners per Incident, a dashed Championships). */
  percent: CompareValueView | null;
  /** What a screen reader hears for this value (FR2.3); empty for an empty slot. */
  srText: string;
}

export interface CompareRowView {
  key: string;
  label: string;
  denominator: string;
  /** The tab edge's colours: the Total leaders' slot colours, none when nothing leads. */
  edge: SlotColour[];
  cells: CompareCellView[];
}

/** The four columns after the stat tab, about 74 px for the tab on phones and 160 px from `sm` up. */
const COLUMNS =
  'grid grid-cols-[4.625rem_repeat(4,minmax(0,1fr))] gap-[3px] sm:grid-cols-[10rem_repeat(4,minmax(0,1fr))] sm:gap-1.5';

/**
 * A filled slot's solid block: the slot colour in both themes, with white text on blue and fixed dark text
 * (`text-black`, as on the nav marquee's fixed strip) on pink, gold and grey, so names reach 4.5:1 in both
 * themes. Grey is the site's solid marker grey.
 */
const SLOT_FILL: Record<SlotColour, string> = {
  blue: 'bg-brand-primary text-fixed-white',
  pink: 'bg-brand-pink text-black',
  gold: 'bg-brand-gold text-black',
  grey: 'bg-gray-400 text-black',
};

/** A slot's colour for the tab edge. A solid blue always carries fixed white text, as everywhere on the site. */
const SLOT_EDGE: Record<SlotColour, string> = {
  blue: 'bg-brand-primary text-fixed-white',
  pink: 'bg-brand-pink',
  gold: 'bg-brand-gold',
  grey: 'bg-gray-400',
};

const TYPE_LABEL: Record<CompareEntity['type'], string> = { driver: 'Driver', team: 'Team', car: 'Car' };

/** Soft hyphens for labels too long for the phone tab, which wrap only where they must. */
const TAB_TEXT: Record<string, string> = { Championships: 'Champion­ships' };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function addClasses(node: HTMLElement, classes: string): HTMLElement {
  node.classList.add(...classes.split(' '));
  return node;
}

/**
 * A short name for the phone header (NFR2): a driver's surname, the first word of a team or car, "Hidden N"
 * for a hidden driver. The full name stays in the accessible text.
 */
export function shortName(entity: Pick<CompareEntity, 'key' | 'type' | 'name'>): string {
  if (entity.key.startsWith('h:')) return `Hidden ${entity.key.slice(2)}`;
  const words = entity.name.trim().split(/\s+/);
  return (entity.type === 'driver' ? words[words.length - 1] : words[0]) || entity.name;
}

/** A filled slot's block: type, name (a link for a driver with a profile) and Clear. */
export function filledSlotHeader(slot: number, entity: CompareEntity, onClear: () => void): HTMLElement {
  const colour = SLOT_COLOURS[slot] ?? 'grey';
  const block = el('div', {
    class: 'flex min-w-0 flex-col items-start gap-1 rounded px-1.5 py-1.5 sm:gap-1.5 sm:px-3.5 sm:py-2.5',
    'data-compare-slot': String(slot),
    'data-compare-fill': colour,
  });
  addClasses(block, SLOT_FILL[colour]);
  // The type and name take the block's own text colour.
  block.append(
    el(
      'span',
      { class: 'hidden text-[0.625rem] font-bold uppercase tracking-wider sm:block' },
      TYPE_LABEL[entity.type],
    ),
  );

  const nameClass = 'block w-full min-w-0 font-display text-sm uppercase leading-none sm:text-[1.3125rem]';
  const name = entity.href
    ? el('a', { href: entity.href, class: `${nameClass} hover:underline` })
    : el('p', { class: nameClass });
  // The full name is always in the accessible text; phones show the short form only.
  name.append(
    el('span', { class: 'sr-only sm:not-sr-only sm:block sm:break-words' }, entity.name),
    el('span', { class: 'block truncate sm:hidden', 'aria-hidden': 'true' }, shortName(entity)),
  );
  block.append(name);

  // The plain outline .btn, inheriting the block's text colour so it reads on every fill in both themes.
  const clear = el('button', {
    type: 'button',
    class: 'btn btn-sm text-inherit px-1.5 py-0.5 sm:px-3 sm:py-1.5',
    'aria-label': `Clear ${entity.name} from slot ${slot + 1}`,
    'data-compare-clear': String(slot),
  });
  clear.append(
    el('span', { class: 'sm:hidden', 'aria-hidden': 'true' }, '×'),
    el('span', { class: 'hidden sm:inline' }, 'Clear'),
  );
  clear.addEventListener('click', onClear);
  block.append(clear);
  return block;
}

/** An empty slot's block, holding the picker. */
export function emptySlotHeader(slot: number, picker: HTMLElement): HTMLElement {
  const block = el('div', {
    class: 'flex min-w-0 flex-col rounded bg-white/5 p-1 sm:p-2.5',
    'data-compare-slot': String(slot),
  });
  block.append(picker);
  return block;
}

/** The tab's left edge: one band per Total leader, split evenly on a tie; with none it stays the tab's grey. */
function tabEdge(colours: SlotColour[]): HTMLElement {
  const edge = el('span', {
    class: 'absolute inset-y-0 left-0 flex w-[3px] flex-col overflow-hidden rounded-l-sm sm:w-1',
    'data-compare-edge': colours.length > 0 ? colours.join(' ') : 'none',
  });
  for (const colour of colours) edge.append(addClasses(el('span', { class: 'flex-1' }), SLOT_EDGE[colour]));
  return edge;
}

/** The stat tab: the label once, its denominator in small text, and the leader edge. Hidden from readers. */
function statTab(row: CompareRowView): HTMLElement {
  const tab = el('div', {
    class:
      'relative flex min-w-0 flex-col justify-center self-stretch rounded-sm bg-white/10 py-1 pl-2 pr-1 sm:py-1.5 sm:pl-3.5 sm:pr-3',
    'aria-hidden': 'true',
    'data-compare-row': row.key,
  });
  tab.append(
    el(
      'span',
      {
        class:
          'font-display text-xs uppercase leading-none tracking-wide sm:text-[1.0625rem] sm:tracking-wider',
      },
      TAB_TEXT[row.label] ?? row.label,
    ),
  );
  if (row.denominator) {
    tab.append(
      el(
        'span',
        { class: 'mt-0.5 text-[0.5625rem] leading-tight text-white/70 sm:text-[0.625rem]' },
        row.denominator,
      ),
    );
  }
  tab.append(tabEdge(row.edge));
  return tab;
}

/**
 * One Total or Percent: a leader sits in the filled, bold pill in inverted colours, a dash is muted, and any
 * other figure is plain. The pill's classes come from the page markup (see towerElement); without them a
 * leader is still bold, and its hidden text still says "leader".
 */
function figure(value: CompareValueView, pillClass: string): HTMLElement {
  if (value.leader) {
    const tag = el('span', { class: pillClass || 'font-bold' }, value.text);
    tag.dataset.leader = 'true';
    return tag;
  }
  if (value.text === DASH) return el('span', { class: 'text-white/60' }, DASH);
  return el('span', {}, value.text);
}

/** One slot's Total and Percent for one row, read as one hidden text; an empty slot is a hidden dot. */
function valueCell(cell: CompareCellView, slot: number, pillClass: string): HTMLElement {
  const box = el('div', { class: 'min-w-0 py-1 pr-0.5 text-right tabular-nums sm:pr-4' });
  box.dataset.compareCell = String(slot);
  if (cell.empty) {
    box.setAttribute('aria-hidden', 'true');
    box.append(el('span', { class: 'text-sm text-white/20' }, '·'));
    return box;
  }
  const figures = el('span', { class: 'block', 'aria-hidden': 'true' });
  const total = el('span', {
    class:
      'block whitespace-nowrap pt-0.5 font-display text-[1.0625rem] leading-none sm:pt-1 sm:text-[1.6875rem]',
  });
  total.append(figure(cell.total, pillClass));
  const percent = el('span', {
    class: 'mt-0.5 block whitespace-nowrap text-[0.625rem] leading-tight text-white/70 sm:text-xs',
  });
  // A row with no Percent keeps its space, so the Totals stay level across the row.
  if (cell.percent) percent.append(figure(cell.percent, pillClass));
  else percent.textContent = ' ';
  figures.append(total, percent);
  box.append(el('span', { class: 'sr-only' }, cell.srText), figures);
  return box;
}

/**
 * The whole tower: the brand cell and slot blocks, then the stat rows, odd rows banded. `pillClass` is the
 * leader pill's class list, read from the `<template data-compare-pill>` in the page markup. It lives there,
 * not here, because the site's inverted pill (`bg-white text-brand-ink`) is a markup class pair: the theme
 * proof treats any class list built in script code as one that might carry the nav marquee's fixed-white
 * attribute, which a plain `bg-white` there can't be told apart from.
 */
export function towerElement(rows: CompareRowView[], headers: HTMLElement[], pillClass = ''): HTMLElement {
  // Bleeds into the page gutter on phones so four columns fit at 320 px.
  const panel = el('div', {
    class: '-mx-2 rounded-xl border border-white/10 p-1.5 sm:mx-0 sm:p-3.5',
    'data-compare-grid': '',
  });
  // Positioned so a phone picker's list can span the whole row instead of its narrow column.
  const head = addClasses(el('div', { class: 'relative mb-1.5 items-stretch sm:mb-2' }), COLUMNS);
  head.append(
    el(
      'p',
      {
        class:
          'self-end pb-1 pl-0.5 font-display text-[0.6875rem] uppercase leading-none tracking-wide text-white/70 sm:pb-2 sm:text-base sm:tracking-[0.14em]',
        'aria-hidden': 'true',
      },
      'ATC Compare',
    ),
    ...headers,
  );
  panel.append(head);
  rows.forEach((row, i) => {
    const line = addClasses(el('div', { class: 'items-center rounded-sm py-0.5' }), COLUMNS);
    if (i % 2 === 0) line.classList.add('bg-white/[0.03]');
    line.append(statTab(row), ...row.cells.map((cell, slot) => valueCell(cell, slot, pillClass)));
    panel.append(line);
  });
  return panel;
}
