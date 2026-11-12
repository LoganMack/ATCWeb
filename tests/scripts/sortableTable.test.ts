/**
 * The shared sorter's comparison (src/scripts/sortable-table.ts; BR2.3): cells marked data-sort-missing stay
 * after every other row in both directions, and tables without the mark sort as before.
 */
import { describe, expect, it } from 'vitest';
import { compareSortEntries, type SortEntry } from '../../src/scripts/sortable-table';

const present = (value: string | number): SortEntry => ({ value, missing: false });
const missing = (label: string): SortEntry => ({ value: label, missing: true });

function sorted(entries: SortEntry[], dir: number): (string | number)[] {
  return [...entries].sort((a, b) => compareSortEntries(a, b, dir)).map((e) => e.value);
}

describe('compareSortEntries', () => {
  const rows = [present(3), missing('a'), present(1), missing('b'), present(2)];

  it('puts missing rows last when sorting ascending', () => {
    expect(sorted(rows, 1)).toEqual([1, 2, 3, 'a', 'b']);
  });

  it('keeps missing rows last when sorting descending', () => {
    expect(sorted(rows, -1)).toEqual([3, 2, 1, 'a', 'b']);
  });

  it('keeps two missing rows in their current order either way', () => {
    expect(compareSortEntries(missing('x'), missing('y'), 1)).toBe(0);
    expect(compareSortEntries(missing('x'), missing('y'), -1)).toBe(0);
  });

  it('sorts unmarked values exactly as before, empty values included', () => {
    const plain = [present(''), present(10), present(2)];
    expect(sorted(plain, 1)).toEqual(['', 2, 10]);
    expect(sorted(plain, -1)).toEqual([10, 2, '']);
  });

  it('compares text values alphabetically', () => {
    expect(sorted([present('gamma'), present('alpha'), present('delta')], 1)).toEqual([
      'alpha',
      'delta',
      'gamma',
    ]);
  });
});
