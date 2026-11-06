/**
 * The shared class filter (FR3.1, FR3.6, FR3.13, BR3.1-BR3.4): one resolver for every page, the five options
 * with their addresses, and which counts a row shows under each filter.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASS_FILTER_VALUES,
  classFilterOptions,
  countsFor,
  filterKeepsClass,
  resolveClassFilter,
  type CountsSource,
} from '../../src/lib/results/classFilter';

const CLASSES = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Gamma' },
  { id: 3, name: 'Delta' },
];

describe('resolveClassFilter (BR3.1)', () => {
  it('opens on Overall when no class is chosen or the value is Overall', () => {
    for (const value of [null, undefined, '', 'Overall']) {
      expect(resolveClassFilter(value, CLASSES)).toMatchObject({ kind: 'overall', addressValue: null });
    }
  });

  it('resolves Combined and each driver class by its exact name', () => {
    expect(resolveClassFilter('Combined', CLASSES)).toMatchObject({ kind: 'combined', label: 'Combined' });
    expect(resolveClassFilter('Alpha', CLASSES)).toMatchObject({ kind: 'class', classId: 1, label: 'Alpha' });
    expect(resolveClassFilter('Gamma', CLASSES)).toMatchObject({ kind: 'class', classId: 2 });
    expect(resolveClassFilter('Delta', CLASSES)).toMatchObject({ kind: 'class', classId: 3 });
  });

  it('falls back to Overall for unknown values, other letter cases and classes the filter does not offer', () => {
    // Exact matching keeps the resolver in step with the edge cache, which keeps only these exact values.
    for (const value of ['Beta', 'alpha', 'COMBINED', '1', '<script>']) {
      expect(resolveClassFilter(value, CLASSES).kind, value).toBe('overall');
    }
    expect(resolveClassFilter('Omega', [...CLASSES, { id: 9, name: 'Omega' }]).kind).toBe('overall');
    expect(CLASS_FILTER_VALUES).toEqual(['Overall', 'Combined', 'Alpha', 'Gamma', 'Delta']);
  });
});

describe('classFilterOptions', () => {
  it('lists Overall, Combined, Alpha, Gamma, Delta with Overall carrying no class value', () => {
    const options = classFilterOptions('/driver-stats', resolveClassFilter('Gamma', CLASSES), CLASSES);
    expect(options.map((o) => [o.label, o.href, o.selected])).toEqual([
      ['Overall', '/driver-stats', false],
      ['Combined', '/driver-stats?class=Combined', false],
      ['Alpha', '/driver-stats?class=Alpha', false],
      ['Gamma', '/driver-stats?class=Gamma', true],
      ['Delta', '/driver-stats?class=Delta', false],
    ]);
  });

  it('keeps other address values and marks Overall selected by default', () => {
    const options = classFilterOptions('/advanced-stats', resolveClassFilter(null, CLASSES), CLASSES, {
      season: '17',
    });
    expect(options[0]).toEqual({ label: 'Overall', href: '/advanced-stats?season=17', selected: true });
    expect(options[1].href).toBe('/advanced-stats?season=17&class=Combined');
  });
});

describe('countsFor and filterKeepsClass (BR3.2-BR3.4)', () => {
  // An Alpha class win at P2 overall: one class win, no overall win.
  const row: CountsSource = {
    classCounts: { wins: 1, podiums: 1, top5s: 1, top10s: 1, poles: 1 },
    overallCounts: { wins: 0, podiums: 1, top5s: 1, top10s: 1, poles: 0 },
  };

  it('shows classless counts under Overall and class counts under Combined or a class', () => {
    expect(countsFor(row, resolveClassFilter(null, CLASSES)).wins).toBe(0);
    expect(countsFor(row, resolveClassFilter('Combined', CLASSES)).wins).toBe(1);
    expect(countsFor(row, resolveClassFilter('Alpha', CLASSES)).poles).toBe(1);
  });

  it('keeps every class under Overall and Combined, and only the chosen class otherwise', () => {
    expect(filterKeepsClass(resolveClassFilter(null, CLASSES), 2)).toBe(true);
    expect(filterKeepsClass(resolveClassFilter('Combined', CLASSES), 3)).toBe(true);
    expect(filterKeepsClass(resolveClassFilter('Delta', CLASSES), 3)).toBe(true);
    expect(filterKeepsClass(resolveClassFilter('Delta', CLASSES), 1)).toBe(false);
  });
});
