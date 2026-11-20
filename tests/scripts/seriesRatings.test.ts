/**
 * The Series iRating table (src/scripts/seriesRatings.ts, src/lib/rating/trend.ts, the ratings fragment; FR7.2,
 * FR8.3, NFR6): header sorting and its direction, the name search and its empty state, the result count, the
 * trend line's direction and label, and that a hidden driver's row is never a link.
 */
import { describe, expect, it } from 'vitest';
import {
  isRatingSortKey,
  matchesSearch,
  nextSort,
  resultCountText,
  sortEntries,
  type RatingEntry,
} from '../../src/scripts/seriesRatings';
import { PROVISIONAL_RACES, TREND_HEIGHT, TREND_WIDTH, trendLine } from '../../src/lib/rating/trend';

// Bundled by Vite's glob import, as the structure tests read page sources.
const FRAGMENT = (
  import.meta.glob('/src/pages/advanced-stats/ratings/fragment.astro', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['/src/pages/advanced-stats/ratings/fragment.astro'];

const entry = (rank: number, name: string, current: number, races: number, last = 0): RatingEntry => ({
  rank,
  name,
  current,
  last,
  min: current - 100,
  max: current + 100,
  races,
});

const ROWS = [entry(1, 'Cara', 2100, 40, 12), entry(2, 'Hidden Driver', 1900, 3, -20), entry(3, 'Abe', 1900, 12, 5)];

describe('sorting', () => {
  it('starts high-first on a number column, A-Z on the name, and flips on a second click', () => {
    const start = { key: 'current' as const, direction: 'descending' as const };
    expect(nextSort(start, 'current')).toEqual({ key: 'current', direction: 'ascending' });
    expect(nextSort(start, 'races')).toEqual({ key: 'races', direction: 'descending' });
    expect(nextSort(start, 'name')).toEqual({ key: 'name', direction: 'ascending' });
    expect(isRatingSortKey('last')).toBe(true);
    expect(isRatingSortKey('trend')).toBe(false);
  });

  it('sorts by the chosen column and keeps the default order for ties', () => {
    expect(sortEntries(ROWS, 'current', 'ascending').map((e) => e.name)).toEqual(['Hidden Driver', 'Abe', 'Cara']);
    expect(sortEntries(ROWS, 'name', 'ascending').map((e) => e.name)).toEqual(['Abe', 'Cara', 'Hidden Driver']);
    expect(sortEntries(ROWS, 'last', 'descending').map((e) => e.rank)).toEqual([1, 3, 2]);
    expect(sortEntries(ROWS, 'races', 'ascending').map((e) => e.races)).toEqual([3, 12, 40]);
  });
});

describe('search', () => {
  it('matches part of the shown name in any case; a hidden driver only as "Hidden Driver"', () => {
    expect(ROWS.filter((e) => matchesSearch(e.name, 'ab')).map((e) => e.name)).toEqual(['Abe']);
    expect(ROWS.filter((e) => matchesSearch(e.name, 'hidden')).map((e) => e.rank)).toEqual([2]);
    expect(ROWS.filter((e) => matchesSearch(e.name, '  ')).length).toBe(3);
    expect(ROWS.filter((e) => matchesSearch(e.name, 'zed')).length).toBe(0);
  });

  it('announces the count, and the fragment carries the no-match state with Clear search (FR8.3)', () => {
    expect(resultCountText(3, 3)).toBe('3 drivers');
    expect(resultCountText(1, 3)).toBe('1 of 3 drivers match');
    expect(resultCountText(0, 3)).toBe('0 of 3 drivers match');
    expect(FRAGMENT).toContain('data-rating-no-match');
    expect(FRAGMENT).toMatch(/<button type="button" class="btn btn-sm ml-2" data-rating-clear>Clear search<\/button>/);
    expect(FRAGMENT).toContain('No ratings yet for this class.');
  });
});

describe('the trend line', () => {
  it('is blue when the shown run ends higher and pink when lower, with a spoken label', () => {
    expect(trendLine([5202, 5180, 5124])).toMatchObject({
      direction: 'down',
      label: 'Falling over last 3 races, 5202 to 5124',
    });
    expect(trendLine([1350, 1416.4])).toMatchObject({ direction: 'up', label: 'Rising over last 2 races, 1350 to 1416' });
    expect(trendLine([1400])).toMatchObject({ direction: 'flat', label: 'Level over 1 race, 1400 to 1400' });
    expect(trendLine([])).toEqual({ points: '', direction: 'flat', label: 'No rated races yet' });
  });

  it('draws at most the last 20 values inside the 80×20 box', () => {
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 10);
    const { points, label } = trendLine(values);
    const coords = points.split(' ').map((p) => p.split(',').map(Number));
    expect(coords).toHaveLength(20);
    expect(label).toBe('Rising over last 20 races, 1100 to 1290');
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(TREND_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(TREND_HEIGHT);
    }
    // Higher ratings are drawn higher (smaller y).
    expect(coords[19][1]).toBeLessThan(coords[0][1]);
  });
});

describe('the ratings fragment', () => {
  it('links only rows with a driver id, so a hidden driver is plain text (FR7.4)', () => {
    expect(FRAGMENT).toMatch(/\{row\.driverId \? <a href=\{`\/drivers\/\$\{row\.driverId\}`\}[^}]*>\{row\.name\}<\/a> : <span>\{row\.name\}<\/span>\}/);
    expect(FRAGMENT).not.toContain('starting_irating');
  });

  it('marks a provisional rating with italics and a titled P tag, and labels each trend SVG', () => {
    expect(PROVISIONAL_RACES).toBe(5);
    expect(FRAGMENT).toContain('title="Provisional: fewer than 5 races">P</span>');
    expect(FRAGMENT).toMatch(/provisional && 'italic'/);
    expect(FRAGMENT).toMatch(/role="img"\s+aria-label=\{trend\.label\}/);
    expect(FRAGMENT).toMatch(/aria-sort=\{h\.key === 'current' \? 'descending' : 'none'\}/);
  });
});
