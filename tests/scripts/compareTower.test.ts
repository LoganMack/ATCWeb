/**
 * The Timing tower as rendered (FR2.1, FR2.3, FR4.2-FR4.4, NFR1): each stat label once, the filled leader pill on
 * a leading Total and a leading Percent, the tab edge in the leaders' slot colours, the solid slot headers and
 * the hidden text each value carries. Vitest runs in Node with no DOM, so the tower is built into a small fake
 * document.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareRowViews } from '../../src/scripts/compareView';
import { emptySlotHeader, filledSlotHeader, towerElement } from '../../src/scripts/compareTower';
import type { CompareEntity } from '../../src/lib/compareRows';

class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, (() => void)[]>();
  private ownText = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  get classes(): string[] {
    return (this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  classList = {
    add: (...names: string[]) => {
      const set = new Set(this.classes);
      for (const n of names) set.add(n);
      this.attributes.set('class', [...set].join(' '));
    },
    contains: (name: string) => this.classes.includes(name),
  };
  dataset = new Proxy({} as Record<string, string>, {
    set: (_t, key: string, value: string) => {
      this.attributes.set(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value);
      return true;
    },
    get: (_t, key: string) =>
      this.attributes.get(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
  });
  set textContent(value: string) {
    this.children = [];
    this.ownText = value;
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  /** Every descendant, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

function entity(key: string, name: string, over: Partial<CompareEntity> = {}): CompareEntity {
  return {
    key,
    type: 'driver',
    name,
    imageUrl: null,
    href: null,
    starts: 10,
    wins: 1,
    podiums: 3,
    top5s: 5,
    top10s: 8,
    poles: 0,
    laps: 200,
    lapsLed: 12,
    championships: 0,
    cornersPerIncident: 40,
    racesEntered: 10,
    raceLaps: 220,
    championshipSeasons: 5,
    ...over,
  };
}

const PILL = 'inline-block rounded-xl bg-white px-0.5 font-bold text-brand-ink sm:px-1.5';
// Amy leads the Wins Total (4 to 2); Ben leads the Wins Percent (2 in 4 starts beats 4 in 10). Both have
// 200 laps, so the Laps Total ties; nobody has a pole.
const AMY = entity('d:1', 'Amy Brown', { wins: 4 });
const BEN = entity('d:2', 'Ben Carter', { wins: 2, starts: 4 });
const SLOTS = [AMY, BEN, null, null];

const asFake = (node: unknown) => node as FakeElement;

function render(pillClass = PILL): FakeElement {
  const headers = SLOTS.map((e, slot) =>
    e ? filledSlotHeader(slot, e, () => {}) : emptySlotHeader(slot, document.createElement('div')),
  );
  return asFake(towerElement(compareRowViews(SLOTS, 20), headers, pillClass));
}

function statRow(tower: FakeElement, key: string): FakeElement {
  const tab = tower.all().find((n) => n.getAttribute('data-compare-row') === key)!;
  return tower.all().find((n) => n.children.includes(tab))!;
}

const cell = (row: FakeElement, slot: number) =>
  row.children.find((c) => c.getAttribute('data-compare-cell') === String(slot))!;

const leaders = (node: FakeElement) => node.all().filter((n) => n.getAttribute('data-leader') === 'true');

beforeAll(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('the rendered Timing tower', () => {
  it('shows each stat label exactly once, in its tab', () => {
    const tower = render();
    const tabs = tower.all().filter((n) => n.getAttribute('data-compare-row'));
    expect(tabs).toHaveLength(10);
    const visible = tower.all().filter((n) => !n.classList.contains('sr-only') && n.children.length === 0);
    for (const label of ['Starts', 'Wins', 'Laps', 'Laps Led', 'Corners per Incident']) {
      expect(visible.filter((n) => n.textContent === label)).toHaveLength(1);
    }
  });

  it('puts a leading Total and a leading Percent in the filled pill, and nothing else', () => {
    const wins = statRow(render(), 'wins');
    const amyLeads = leaders(cell(wins, 0));
    const benLeads = leaders(cell(wins, 1));
    expect(amyLeads.map((n) => n.textContent)).toEqual(['4']); // the Total
    expect(benLeads.map((n) => n.textContent)).toEqual(['50.0%']); // the Percent
    for (const pill of [...amyLeads, ...benLeads]) {
      expect(pill.classes).toEqual(PILL.split(' '));
    }
    // A figure that doesn't lead carries no fill.
    const plain = cell(wins, 1)
      .all()
      .find((n) => n.textContent === '2' && n.children.length === 0)!;
    expect(plain.classList.contains('bg-white')).toBe(false);
  });

  it('still marks a leader in bold when the page has no pill template', () => {
    const [pill] = leaders(cell(statRow(render(''), 'wins'), 0));
    expect(pill.classes).toEqual(['font-bold']);
  });

  it('colours the tab edge by the Total leaders: one slot, a tie, or none', () => {
    const tower = render();
    const edge = (key: string) =>
      tower.all().find((n) => n.getAttribute('data-compare-edge') && statRow(tower, key).all().includes(n))!;
    expect(edge('wins').getAttribute('data-compare-edge')).toBe('blue');
    expect(edge('wins').children.map((c) => c.classList.contains('bg-brand-primary'))).toEqual([true]);
    const tie = edge('laps');
    expect(tie.getAttribute('data-compare-edge')).toBe('blue pink');
    expect(tie.children.map((c) => c.classes.find((x) => x.startsWith('bg-')))).toEqual([
      'bg-brand-primary',
      'bg-brand-pink',
    ]);
    expect(edge('poles').getAttribute('data-compare-edge')).toBe('none');
    expect(edge('poles').children).toHaveLength(0);
  });

  it('gives every filled value one hidden text and hides an empty slot', () => {
    const wins = statRow(render(), 'wins');
    const srOnly = (n: FakeElement) => n.children.filter((c) => c.classList.contains('sr-only'));
    expect(srOnly(cell(wins, 0)).map((n) => n.textContent)).toEqual([
      'Wins, Amy Brown: 4, leader; 40.0% of starts',
    ]);
    expect(srOnly(cell(wins, 1)).map((n) => n.textContent)).toEqual([
      'Wins, Ben Carter: 2; 50.0% of starts, leader',
    ]);
    expect(cell(wins, 2).getAttribute('aria-hidden')).toBe('true');
    expect(srOnly(cell(wins, 2))).toHaveLength(0);
  });
});

describe('the solid slot headers', () => {
  it('fills each slot with its colour and a readable text colour in both themes', () => {
    const fill = (slot: number) => asFake(filledSlotHeader(slot, AMY, () => {}));
    expect(fill(0).classes).toEqual(expect.arrayContaining(['bg-brand-primary', 'text-fixed-white']));
    expect(fill(1).classes).toEqual(expect.arrayContaining(['bg-brand-pink', 'text-black']));
    expect(fill(2).classes).toEqual(expect.arrayContaining(['bg-brand-gold', 'text-black']));
    // Grey is a solid fill too, not a bordered strip.
    expect(fill(3).classes).toEqual(expect.arrayContaining(['bg-gray-400', 'text-black']));
    expect(fill(3).classes.some((c) => c.startsWith('border'))).toBe(false);
    expect(
      fill(1)
        .all()
        .some((n) => n.classes.some((c) => c.startsWith('text-white'))),
    ).toBe(false);
  });

  it("gives Clear the block's own text colour and clears the slot", () => {
    const onClear = vi.fn();
    const header = asFake(filledSlotHeader(2, AMY, onClear));
    const clear = header.all().find((n) => n.getAttribute('data-compare-clear') === '2')!;
    expect(clear.classes).toEqual(expect.arrayContaining(['btn', 'btn-sm', 'text-inherit']));
    expect(clear.getAttribute('aria-label')).toBe('Clear Amy Brown from slot 3');
    clear.click();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
