/**
 * The Compare rows (FR3, FR4, NFR5): the ten stats in order, each Percent against its own denominator, dashes
 * for zero denominators and blanks where a stat has no Percent, the Total and Percent leaders, and the stat
 * tab's edge colours.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPARE_ROWS,
  DASH,
  edgeColours,
  formatPercent,
  formatPercentValue,
  percentOf,
  rowLeaders,
  type CompareEntity,
} from '../../src/lib/compareRows';

function entity(over: Partial<CompareEntity> = {}): CompareEntity {
  return {
    key: 'd:1',
    type: 'driver',
    name: 'Ann Able',
    imageUrl: null,
    href: null,
    starts: 50,
    wins: 12,
    podiums: 20,
    top5s: 30,
    top10s: 40,
    poles: 5,
    laps: 1900,
    lapsLed: 190,
    championships: 2,
    cornersPerIncident: 41.25,
    racesEntered: 50,
    raceLaps: 2000,
    championshipSeasons: 5,
    ...over,
  };
}

const CTX = { races: 60 };
const rowOf = (key: string) => COMPARE_ROWS.find((r) => r.key === key)!;
const percentText = (key: string, e: CompareEntity, ctx = CTX) =>
  formatPercentValue(rowOf(key).percent(e, ctx));

describe('the ten rows (FR3.2, FR3.3)', () => {
  it('lists the ten stats in order, each label once, with no Win % or Podium % rows', () => {
    expect(COMPARE_ROWS.map((r) => r.label)).toEqual([
      'Starts',
      'Wins',
      'Podiums',
      'Top 5s',
      'Top 10s',
      'Poles',
      'Laps',
      'Laps Led',
      'Championships',
      'Corners per Incident',
    ]);
    expect(COMPARE_ROWS.map((r) => r.key)).not.toContain('winRate');
    expect(COMPARE_ROWS.map((r) => r.key)).not.toContain('podiumRate');
    expect(COMPARE_ROWS.some((r) => r.label.includes('%'))).toBe(false);
  });

  it('measures each Percent against its own denominator', () => {
    const e = entity();
    expect(
      Object.fromEntries(
        COMPARE_ROWS.map((r) => [r.key, [r.denominator, formatPercentValue(r.percent(e, CTX))]]),
      ),
    ).toEqual({
      starts: ['% of races', '83.3%'], // 50 races entered of 60
      wins: ['% of starts', '24.0%'],
      podiums: ['% of starts', '40.0%'],
      top5s: ['% of starts', '60.0%'],
      top10s: ['% of starts', '80.0%'],
      poles: ['% of starts', '10.0%'],
      laps: ['% of race laps', '95.0%'], // 1,900 of 2,000
      lapsLed: ['% of laps', '10.0%'], // 190 of 1,900
      championships: ['% of finished seasons', '40.0%'], // 2 of 5
      cpi: ['', ''],
    });
  });

  it('measures a team’s Starts % by races entered, so two cars in one race never pass 100%', () => {
    const team = entity({ key: 't:1', type: 'team', starts: 110, racesEntered: 60 });
    expect(percentText('starts', team)).toBe('100.0%');
    expect(rowOf('starts').total.format(team)).toBe('110');
  });

  it('formats Totals with thousands separators and Corners per Incident with one decimal (FR3.7)', () => {
    const e = entity({ laps: 12345 });
    expect(rowOf('laps').total.format(e)).toBe('12,345');
    expect(rowOf('cpi').total.format(e)).toBe('41.3');
    expect(rowOf('cpi').total.format(entity({ cornersPerIncident: null }))).toBe(DASH);
  });
});

describe('dashes and blanks (FR3.6, FR3.8)', () => {
  it('shows a dash, never NaN, Infinity or 0.0%, for every zero denominator', () => {
    const none = entity({
      starts: 0,
      wins: 0,
      racesEntered: 0,
      laps: 0,
      raceLaps: 0,
      championshipSeasons: 0,
    });
    for (const key of ['starts', 'wins', 'poles', 'laps', 'lapsLed', 'championships']) {
      expect(percentText(key, none, { races: 0 }), key).toBe(DASH);
    }
    expect(formatPercent(3, 0)).toBe(DASH);
    expect(formatPercent(3, null)).toBe(DASH);
    expect(formatPercentValue(Number.NaN)).toBe(DASH);
    expect(formatPercent(1, 3)).toBe('33.3%');
    expect(percentOf(1, undefined)).toBeNull();
  });

  it('keeps a real zero distinct from a dash', () => {
    expect(percentText('wins', entity({ wins: 0 }))).toBe('0.0%');
    expect(rowOf('wins').percent(entity({ wins: 0 }), CTX)).toBe(0);
  });

  it('leaves the Percent blank for Corners per Incident and wherever Championships is a dash', () => {
    expect(rowOf('cpi').percent(entity(), CTX)).toBeUndefined();
    const car = entity({ key: 'c:x', type: 'car', championships: null, championshipSeasons: null });
    expect(rowOf('championships').total.format(car)).toBe(DASH);
    expect(rowOf('championships').percent(car, CTX)).toBeUndefined();
    expect(formatPercentValue(undefined)).toBe('');
  });

  it('shows a dash for a known championship count with no finished season (one unfinished season chosen)', () => {
    expect(percentText('championships', entity({ championships: 0, championshipSeasons: 0 }))).toBe(DASH);
  });
});

describe('leaders (FR4.2, FR4.3)', () => {
  it('leads the Total and the Percent separately, so they can belong to different entries', () => {
    const busy = entity({ starts: 50, wins: 12 }); // 24.0%
    const sharp = entity({ key: 'd:2', starts: 20, wins: 8 }); // 40.0%
    const row = rowOf('wins');
    expect(rowLeaders([busy, sharp].map((e) => row.total.value(e))).leaders).toEqual([true, false]);
    expect(rowLeaders([busy, sharp].map((e) => row.percent(e, CTX))).leaders).toEqual([false, true]);
  });

  it('lets every tied best lead and ignores empty slots, dashes and blanks', () => {
    expect(rowLeaders([4, 8, null, 8]).leaders).toEqual([false, true, false, true]);
    expect(rowLeaders([undefined, 3, 2, null]).leaders).toEqual([false, true, false, false]);
  });

  it('has no leader with fewer than two numbers or a best of 0', () => {
    expect(rowLeaders([5, null, undefined, null]).leaders).toEqual([false, false, false, false]);
    expect(rowLeaders([0, 0, null, null]).leaders).toEqual([false, false, false, false]);
    expect(rowLeaders([]).leaders).toEqual([]);
  });
});

describe('the tab edge (owner’s gate: coloured by the Total leader)', () => {
  it('takes the slot colour of one leader, splits on a tie and is neutral with none', () => {
    expect(edgeColours([false, true, false, false])).toEqual(['pink']);
    expect(edgeColours([true, false, true, true])).toEqual(['blue', 'gold', 'grey']);
    expect(edgeColours([false, false, false, false])).toEqual([]);
  });
});
