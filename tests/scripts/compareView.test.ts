/**
 * The Advanced Stats Compare view's browser helpers (FR4, BR4.4, BR4.10-BR4.12): picks read from and written
 * to the address, unknown keys leaving a slot empty, picker filtering with group caps, keyboard movement,
 * leaders recomputed when a slot changes, and the picks carried to a new Class or Season address. The tests
 * have no DOM, so the delegated wiring in src/scripts/compareView.ts is not loaded in Node.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addressWithPicks,
  cellLabel,
  compareGridItems,
  compareRowViews,
  nextActiveIndex,
  parseCompareData,
} from '../../src/scripts/compareView';
import {
  filterPickerEntries,
  readPicks,
  resolvePicks,
  writePicks,
  type CompareData,
  type CompareEntity,
} from '../../src/lib/compareRows';

function entity(key: string, name: string, over: Partial<CompareEntity> = {}): CompareEntity {
  const type = key.startsWith('d:') ? 'driver' : key.startsWith('t:') ? 'team' : 'car';
  return {
    key,
    type,
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
    championships: type === 'car' ? null : 0,
    cornersPerIncident: type === 'driver' ? 40 : null,
    ...over,
  };
}

const DATA: CompareData = {
  classLabel: 'Overall',
  seasonLabel: 'All seasons',
  drivers: [entity('d:1', 'Amy Brown', { wins: 4 }), entity('d:2', 'Ben Carter', { wins: 2 })],
  teams: [entity('t:9', 'Blue Racing')],
  cars: [entity('c:Hyundai Elantra N TC', 'Hyundai Elantra N TC', { wins: 4 })],
};

const row = (key: string, slots: (CompareEntity | null)[]) =>
  compareRowViews(slots).find((r) => r.key === key)!;

describe('picks in the address (BR4.4)', () => {
  it('reads the four slots and writes them back, keeping the filters', () => {
    expect(readPicks('?class=Delta&a=d:1&c=t:9')).toEqual(['d:1', null, 't:9', null]);
    expect(writePicks('?class=Delta&a=d:1', ['d:1', 'c:Honda Civic Type R TCR', null, null])).toBe(
      '?class=Delta&a=d%3A1&b=c%3AHonda+Civic+Type+R+TCR',
    );
    expect(readPicks(writePicks('?season=17', [null, 'd:2', null, 'c:Audi RS3 LMS']))).toEqual([
      null,
      'd:2',
      null,
      'c:Audi RS3 LMS',
    ]);
  });

  it('leaves a slot empty for an unknown or malformed key', () => {
    expect(resolvePicks(DATA, ['d:1', 'd:404', 'x:1', 'nonsense']).map((e) => e?.name ?? null)).toEqual([
      'Amy Brown',
      null,
      null,
      null,
    ]);
  });

  it('carries only the picks to a Class or Season address', () => {
    expect(addressWithPicks('/advanced-stats?class=Delta', '?a=d:1&class=Alpha&season=3&b=t:9')).toBe(
      '/advanced-stats?class=Delta&a=d%3A1&b=t%3A9',
    );
    expect(addressWithPicks('/advanced-stats', '?a=d:1')).toBe('/advanced-stats?a=d%3A1');
    expect(addressWithPicks('/advanced-stats?season=4', '?class=Gamma')).toBe('/advanced-stats?season=4');
  });
});

describe('the EntityPicker (BR4.11)', () => {
  it('filters by name across groups and caps each group with a "more" count', () => {
    const groups = filterPickerEntries(DATA, 'b');
    expect(groups.map((g) => [g.label, g.items.map((e) => e.name)])).toEqual([
      ['Drivers', ['Amy Brown', 'Ben Carter']],
      ['Teams', ['Blue Racing']],
    ]);
    const many = {
      drivers: Array.from({ length: 60 }, (_, i) => entity(`d:${i}`, `Driver ${i}`)),
      teams: [],
      cars: [],
    };
    const [capped] = filterPickerEntries(many, 'driver');
    expect(capped.items).toHaveLength(50);
    expect(capped.more).toBe(10);
  });

  it('moves the highlight with the arrow keys, wrapping at both ends', () => {
    expect(nextActiveIndex(-1, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextActiveIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextActiveIndex(-1, 3, 'ArrowUp')).toBe(2);
    expect(nextActiveIndex(1, 3, 'Enter')).toBe(1);
    expect(nextActiveIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});

describe('rows, leaders and bars (BR4.10)', () => {
  it('recomputes the leader when a slot changes', () => {
    const [amy, ben] = DATA.drivers;
    const before = row('wins', [amy, ben, null, null]);
    expect(before.cells.map((c) => c.leader)).toEqual([true, false, false, false]);
    expect(before.cells.map((c) => c.width)).toEqual([100, 50, 0, 0]);
    const after = row('wins', [entity('d:3', 'Cat', { wins: 6 }), ben, null, amy]);
    expect(after.cells.map((c) => c.leader)).toEqual([true, false, false, false]);
    expect(after.cells[3].text).toBe('4');
    expect(after.cells[2].empty).toBe(true);
  });

  it('shows dashes and no leader for a car championship or a lone value', () => {
    const car = DATA.cars[0];
    const champs = row('championships', [car, DATA.teams[0], null, null]);
    expect(champs.cells[0].text).toBe('—');
    expect(champs.cells.some((c) => c.leader)).toBe(false); // the team's 0 is the only number
    expect(row('wins', [car, null, null, null]).cells[0].leader).toBe(false);
    expect(compareRowViews([null, null, null, null])).toHaveLength(12);
  });
});

describe('accessible names and the phone layout (BR4.12)', () => {
  it('names whose value each stat cell is, with the leader and dashes spoken plainly', () => {
    const [amy, ben] = DATA.drivers;
    const wins = row('wins', [amy, ben, null, null]);
    expect(cellLabel(wins.label, amy.name, wins.cells[0])).toBe('Wins, Amy Brown: 4, leader');
    expect(cellLabel(wins.label, ben.name, wins.cells[1])).toBe('Wins, Ben Carter: 2');
    const car = DATA.cars[0];
    const champs = row('championships', [car, null, null, null]);
    expect(cellLabel(champs.label, car.name, champs.cells[0])).toBe(
      'Championships, Hyundai Elantra N TC: none',
    );
  });

  it('groups the phone layout in pairs: slots 1-2 with their rows, then slots 3-4 with theirs', () => {
    const items = compareGridItems(4, 12);
    const secondPair = items.findIndex((i) => i.kind === 'slot' && i.slot === 2);
    const first = items.slice(0, secondPair);
    const second = items.slice(secondPair);
    expect(first.filter((i) => i.kind !== 'label').every((i) => i.slot === 0 || i.slot === 1)).toBe(true);
    expect(second.filter((i) => i.kind !== 'label').every((i) => i.slot === 2 || i.slot === 3)).toBe(true);
    // Each pair: its two cards, then every stat label followed by that pair's two cells.
    expect(first.slice(0, 5).map((i) => [i.kind, i.slot, i.row])).toEqual([
      ['slot', 0, null],
      ['slot', 1, null],
      ['label', null, 0],
      ['cell', 0, 0],
      ['cell', 1, 0],
    ]);
    expect(first.filter((i) => i.kind === 'label')).toHaveLength(12);
    expect(second.filter((i) => i.kind === 'label').every((i) => i.phoneOnly)).toBe(true);
    expect(first.some((i) => i.phoneOnly)).toBe(false);
  });

  it('orders the same items four across from sm up: the cards, then each label with its four cells', () => {
    const shown = compareGridItems(4, 12)
      .filter((i) => !i.phoneOnly)
      .sort((a, b) => a.wideOrder - b.wideOrder);
    expect(new Set(shown.map((i) => i.wideOrder)).size).toBe(shown.length);
    expect(shown.slice(0, 9).map((i) => [i.kind, i.slot, i.row])).toEqual([
      ['slot', 0, null],
      ['slot', 1, null],
      ['slot', 2, null],
      ['slot', 3, null],
      ['label', null, 0],
      ['cell', 0, 0],
      ['cell', 1, 0],
      ['cell', 2, 0],
      ['cell', 3, 0],
    ]);
    expect(shown).toHaveLength(4 + 12 * 5);
  });
});

describe('the embedded data', () => {
  it('reads the fragment JSON and refuses a missing or broken block', () => {
    expect(parseCompareData(JSON.stringify(DATA))?.drivers).toHaveLength(2);
    expect(parseCompareData(null)).toBeNull();
    expect(parseCompareData('{"drivers":1}')).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseCompareData('{not json')).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
