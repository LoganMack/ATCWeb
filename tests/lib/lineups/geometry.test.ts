/**
 * The Lineup Changes geometry (src/lib/lineups/geometry.ts): row centres and column height for 5-unit rows with
 * a 1-unit gap, shared by the server render and the Teams filter's relayout, and the line path.
 */
import { describe, expect, it } from 'vitest';
import { GAP_UNITS, linePath, placeRows, ROW_UNITS } from '../../../src/lib/lineups/geometry';

describe('placeRows', () => {
  it('stacks rows with a gap between groups and a heading row before a change group', () => {
    expect([ROW_UNITS, GAP_UNITS]).toEqual([5, 1]);
    const placed = placeRows([
      { heading: false, rows: 2 },
      { heading: true, rows: 1 },
    ]);
    // Team: rows 0-5 and 5-10. Gap to 11. Heading 11-16. Seat 16-21.
    expect(placed).toEqual({ centres: [[2.5, 7.5], [18.5]], height: 21 });
  });

  it('skips an empty group, with no gap and no heading, so a filtered-out team leaves no space', () => {
    const placed = placeRows([
      { heading: false, rows: 0 },
      { heading: false, rows: 1 },
      { heading: true, rows: 0 },
      { heading: false, rows: 1 },
    ]);
    expect(placed).toEqual({ centres: [[], [2.5], [], [8.5]], height: 11 });
    expect(placeRows([])).toEqual({ centres: [], height: 0 });
    expect(placeRows([{ heading: true, rows: 0 }]).height).toBe(0);
  });
});

describe('linePath', () => {
  it('draws a curve from the left edge at y1 to the right edge at y2, to one decimal', () => {
    expect(linePath({ y1: 2.5, y2: 18.25 })).toBe('M0 2.5 C50 2.5 50 18.3 100 18.3');
  });
});
