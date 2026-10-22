/**
 * The driver page's race list: Start is the grid slot within the driver's class (from
 * curated_race_results.starting_position), Finish the shown position from race_score_results_public.
 * Shapes from driver 49a39606…, an Alpha driver: ATC18 Round 6 (89494354, unposted, laps down) and
 * ATC16 Round 1 (82494956, a normal finish).
 */
import { describe, expect, it } from 'vitest';
import { classStartingPositions, historyFinish, type ClassFieldRow } from '../../src/lib/results/raceHistory';

const ALPHA = 1;
const GAMMA = 2;
const field = (sub: number, rows: [string, number, number | null][]): ClassFieldRow[] =>
  rows.map(([driver_id, class_id, starting_position]) => ({
    subsession_id: sub,
    race_number: 1,
    driver_id,
    class_id,
    starting_position,
  }));

describe('driver race list', () => {
  it('pins Start and Finish for a laps-down row on an unposted round', () => {
    // Overall: starts 1st, finishes 34th, 14 laps down; 5th of the Alpha drivers. Non-admins see the raw set.
    const starts = classStartingPositions(
      field(89494354, [
        ['me', ALPHA, 1],
        ['a2', ALPHA, 3],
        ['g1', GAMMA, 2],
        ['a3', ALPHA, null],
      ]),
    );
    expect(starts.get('89494354:1:me')).toBe(1);
    expect(starts.get('89494354:1:a2')).toBe(2);
    expect(starts.has('89494354:1:a3')).toBe(false);
    const finish = historyFinish({ position: 34, finish_position: 34, class_position: 5, dsq: false });
    expect(finish).toEqual({ finishPosition: 34, classPosition: 5 });
  });

  it('pins Start and Finish for a normal row, and counts a repeated field row once', () => {
    // Overall: starts 1st and finishes 4th; also 1st and 4th among Alpha.
    const rows = field(82494956, [
      ['me', ALPHA, 1],
      ['g1', GAMMA, 2],
      ['a2', ALPHA, 4],
      ['a2', ALPHA, 4],
      ['g2', GAMMA, 3],
    ]);
    const starts = classStartingPositions(rows);
    expect(starts.get('82494956:1:me')).toBe(1);
    expect(starts.get('82494956:1:a2')).toBe(2);
    expect(starts.get('82494956:1:g2')).toBe(2);
    expect(historyFinish({ position: 4, finish_position: 4, class_position: 4, dsq: false })).toEqual({
      finishPosition: 4,
      classPosition: 4,
    });
  });

  it('shows a DSQ at its finishing slot with no class position', () => {
    expect(historyFinish({ position: null, finish_position: 7, class_position: null, dsq: true })).toEqual({
      finishPosition: 7,
      classPosition: null,
    });
  });
});
