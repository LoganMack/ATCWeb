/**
 * The Advanced Stats Compare view's browser helpers (FR4, BR4.4, BR4.10-BR4.12; Timing tower FR2-FR5): picks
 * read from and written to the address, unknown keys leaving a slot empty, picker filtering with group caps,
 * keyboard movement, the ten rows with separate Total and Percent leaders and their tab edges, the hidden
 * text each value carries, and the picks carried to a new Class or Season address. The tests have no DOM, so
 * the delegated wiring in src/scripts/compareView.ts is not loaded in Node.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addressWithPicks,
  cellLabel,
  compareRowViews,
  nextActiveIndex,
  parseCompareData,
} from '../../src/scripts/compareView';
import { shortName } from '../../src/scripts/compareTower';
import {
  filterPickerEntries,
  readPicks,
  resolvePicks,
  writePicks,
  type CompareData,
  type CompareEntity,
} from '../../src/lib/compareRows';

function entity(key: string, name: string, over: Partial<CompareEntity> = {}): CompareEntity {
  const type = /^[dh]:/.test(key) ? 'driver' : key.startsWith('t:') ? 'team' : 'car';
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
    racesEntered: 10,
    raceLaps: 220,
    championshipSeasons: type === 'car' ? null : 5,
    ...over,
  };
}

const DATA: CompareData = {
  classLabel: 'Overall',
  seasonLabel: 'All seasons',
  races: 20,
  drivers: [entity('d:1', 'Amy Brown', { wins: 4 }), entity('d:2', 'Ben Carter', { wins: 2 })],
  teams: [entity('t:9', 'Blue Racing')],
  cars: [entity('c:Hyundai Elantra N TC', 'Hyundai Elantra N TC', { wins: 4 })],
};

const row = (key: string, slots: (CompareEntity | null)[]) =>
  compareRowViews(slots, DATA.races).find((r) => r.key === key)!;

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

describe('the Timing tower rows (FR2.1, FR3, FR4)', () => {
  it('has ten rows, each label exactly once, with no bar or width left in the view', () => {
    const rows = compareRowViews([...DATA.drivers, null, null], DATA.races);
    expect(rows).toHaveLength(10);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(10);
    expect(labels).not.toContain('Win %');
    expect(labels).not.toContain('Podium %');
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/"width"|"widths"|"bar"/);
    // The labels live on the row, never repeated in a cell's visible fields.
    for (const r of rows)
      for (const c of r.cells) expect([c.total.text, c.percent?.text]).not.toContain(r.label);
  });

  it('recomputes the Total and Percent leaders separately when a slot changes', () => {
    const [amy, ben] = DATA.drivers;
    // Amy: 4 wins in 10 starts; Ben: 2 in 4 starts, the better rate.
    const ben4 = { ...ben, starts: 4, racesEntered: 4 };
    const wins = row('wins', [amy, ben4, null, null]);
    expect(wins.cells.map((c) => c.total.leader)).toEqual([true, false, false, false]);
    expect(wins.cells.map((c) => c.percent?.leader)).toEqual([false, true, undefined, undefined]);
    expect(wins.cells.map((c) => c.percent?.text)).toEqual(['40.0%', '50.0%', undefined, undefined]);
    const after = row('wins', [entity('d:3', 'Cat', { wins: 6 }), ben4, null, amy]);
    expect(after.cells.map((c) => c.total.leader)).toEqual([true, false, false, false]);
    expect(after.cells[3].total.text).toBe('4');
    expect(after.cells[2].empty).toBe(true);
  });

  it('colours each tab edge by the Total leaders: one slot, a tie, or none', () => {
    const [amy, ben] = DATA.drivers;
    expect(row('wins', [null, amy, null, ben]).edge).toEqual(['pink']);
    expect(row('starts', [amy, null, ben, null]).edge).toEqual(['blue', 'gold']); // 10 starts each
    expect(row('poles', [amy, ben, null, null]).edge).toEqual([]); // a best of 0
    expect(row('wins', [amy, null, null, null]).edge).toEqual([]); // a lone value
  });

  it('shows dashes and blanks: no leader for a car championship, no Percent for CPI', () => {
    const car = DATA.cars[0];
    const champs = row('championships', [car, DATA.teams[0], null, null]);
    expect(champs.cells[0].total.text).toBe('—');
    expect(champs.cells[0].percent).toBeNull();
    expect(champs.cells.some((c) => c.total.leader)).toBe(false); // the team's 0 is the only number
    expect(row('cpi', [DATA.drivers[0], car, null, null]).cells.map((c) => c.percent)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(compareRowViews([null, null, null, null], 0)).toHaveLength(10);
  });
});

describe('accessible text (FR2.3, FR4.4, FR5.3)', () => {
  it('speaks the stat, the name, the Total, the Percent and each leader', () => {
    const [amy, ben] = DATA.drivers;
    const wins = row('wins', [amy, ben, null, null]);
    expect(wins.cells[0].srText).toBe('Wins, Amy Brown: 4, leader; 40.0% of starts, leader');
    expect(wins.cells[1].srText).toBe('Wins, Ben Carter: 2; 20.0% of starts');
    expect(cellLabel(wins, amy.name, wins.cells[0])).toBe(wins.cells[0].srText);
    expect(wins.cells[2].srText).toBe('');
  });

  it('says "no rate" for a dashed Percent, "none" for a dashed Total, and leaves out a blank Percent', () => {
    const rookie = entity('d:9', 'Rae Rookie', {
      starts: 0,
      racesEntered: 0,
      wins: 0,
      cornersPerIncident: null,
    });
    expect(row('wins', [rookie, null, null, null]).cells[0].srText).toBe('Wins, Rae Rookie: 0; no rate');
    const car = DATA.cars[0];
    expect(row('championships', [car, null, null, null]).cells[0].srText).toBe(
      'Championships, Hyundai Elantra N TC: none',
    );
    expect(row('cpi', [DATA.drivers[0], null, null, null]).cells[0].srText).toBe(
      'Corners per Incident, Amy Brown: 40.0',
    );
  });

  it('names a hidden driver only as "Hidden Driver N", in full and short form', () => {
    const hidden = entity('h:2', 'Hidden Driver 2');
    expect(hidden.type).toBe('driver');
    expect(row('starts', [hidden, null, null, null]).cells[0].srText).toBe(
      'Starts, Hidden Driver 2: 10; 50.0% of races',
    );
    expect(shortName(hidden)).toBe('Hidden 2');
    expect(shortName(DATA.drivers[0])).toBe('Brown');
    expect(shortName(DATA.cars[0])).toBe('Hyundai');
  });
});

describe('the embedded data', () => {
  it('reads the fragment JSON and refuses a missing or broken block', () => {
    expect(parseCompareData(JSON.stringify(DATA))?.drivers).toHaveLength(2);
    expect(parseCompareData(JSON.stringify(DATA))?.races).toBe(20);
    // A fragment cached from before `races` existed reads as 0 races, a dash rather than a wrong figure.
    const { races: _races, ...old } = DATA;
    expect(parseCompareData(JSON.stringify(old))?.races).toBe(0);
    expect(parseCompareData(null)).toBeNull();
    expect(parseCompareData('{"drivers":1}')).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseCompareData('{not json')).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
