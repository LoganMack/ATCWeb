/**
 * The shared up and down rule of the Series iRating lines (src/lib/rating/segments.ts; U2 BR1.1, BR1.2,
 * NFR7.1): one direction per segment on whole numbers, flat keeping the previous one, and the runs the trend
 * lines and the chart draw, which share their boundary points.
 */
import { describe, expect, it } from 'vitest';
import { directionRuns, segmentDirections } from '../../src/lib/rating/segments';

describe('segmentDirections', () => {
  it('marks a rise up and a fall down (AC1.1.1)', () => {
    expect(segmentDirections([1500, 1530, 1510])).toEqual(['up', 'down']);
  });

  it('keeps the previous direction for a flat segment after a fall (AC1.1.3)', () => {
    expect(segmentDirections([1530, 1510, 1510, 1520])).toEqual(['down', 'down', 'up']);
  });

  it('makes a flat first segment up, and an all-flat line all up (AC1.1.3)', () => {
    expect(segmentDirections([1500, 1500, 1480])).toEqual(['up', 'down']);
    expect(segmentDirections([1500, 1500, 1500])).toEqual(['up', 'up']);
  });

  it('compares whole numbers, as the page shows them', () => {
    expect(segmentDirections([1416.2, 1416.4])).toEqual(['up']); // flat, first segment
    expect(segmentDirections([1420, 1416.2, 1416.4])).toEqual(['down', 'down']); // flat keeps down
    expect(segmentDirections([1416.4, 1416.6])).toEqual(['up']); // 1416 to 1417
    expect(segmentDirections([1420, 1417.4, 1416.6])).toEqual(['down', 'down']); // both 1417: flat
  });

  it('gives no segments for 0 or 1 value', () => {
    expect(segmentDirections([])).toEqual([]);
    expect(segmentDirections([1500])).toEqual([]);
  });
});

describe('directionRuns', () => {
  it('merges equal neighbours, and adjacent runs share their boundary point', () => {
    expect(directionRuns(['up', 'up', 'down', 'up'])).toEqual([
      { direction: 'up', from: 0, to: 2 },
      { direction: 'down', from: 2, to: 3 },
      { direction: 'up', from: 3, to: 4 },
    ]);
  });

  it('gives one run for one direction and none for no segments', () => {
    expect(directionRuns(['down', 'down', 'down'])).toEqual([{ direction: 'down', from: 0, to: 3 }]);
    expect(directionRuns([])).toEqual([]);
  });
});
