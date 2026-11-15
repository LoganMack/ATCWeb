/**
 * The driver page's race list: Start is the grid slot within the driver's class (from
 * curated_race_results.starting_position), Finish the shown position from race_score_results_public.
 * Shapes from driver 49a39606…, an Alpha driver: ATC18 Round 6 (89494354, unposted, laps down) and
 * ATC16 Round 1 (82494956, a normal finish).
 */
import { describe, expect, it } from 'vitest';
import { classStartingPositions, historyFinish, type ClassFieldRow } from '../../src/lib/results/raceHistory';
import {
  classLeaders,
  classMarginText,
  marginSortValue,
  type ClassLeaderFieldRow,
} from '../../src/lib/results/classMargin';
import { formatMargin } from '../../src/lib/results/format';

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

  it('shows a DSQ at its finishing slot with no class position, as overall and class finish', () => {
    expect(historyFinish({ position: null, finish_position: 7, class_position: null, dsq: true })).toEqual({
      finishPosition: 7,
      classPosition: null,
    });
  });
});

describe('Races table Class margin (BR3.3, BR3.4)', () => {
  const scored = (
    driver_id: string,
    class_id: number,
    finish_position: number,
    dsq = false,
  ): ClassLeaderFieldRow => ({ subsession_id: 7, race_number: 1, driver_id, class_id, finish_position, dsq });
  const raw = (interval: number | null, laps: number) => ({
    interval_ten_thousandths: interval,
    laps_complete: laps,
  });

  it('measures the gap to the class leader, not the overall winner', () => {
    const leaders = classLeaders([scored('a1', ALPHA, 1), scored('g1', GAMMA, 3), scored('me', GAMMA, 5)]);
    expect(leaders.get(`7:1:${GAMMA}`)).toBe('g1');
    // Overall winner 0s, class leader +12.5s, me +20.0s on the same lap.
    expect(formatMargin(200_000, 20, 20)).toBe('20.000');
    expect(classMarginText(raw(200_000, 20), raw(125_000, 20), 20)).toBe('7.500');
  });

  it('skips a DSQ driver when picking the class leader, using the pre-penalty finish', () => {
    const leaders = classLeaders([
      scored('g1', GAMMA, 2, true),
      scored('g2', GAMMA, 4),
      scored('g3', GAMMA, 3),
    ]);
    expect(leaders.get(`7:1:${GAMMA}`)).toBe('g3');
  });

  it('can name an AI driver as class leader', () => {
    expect(classLeaders([scored('ai-1', GAMMA, 2), scored('me', GAMMA, 6)]).get(`7:1:${GAMMA}`)).toBe('ai-1');
  });

  it('counts laps down against the class leader, and falls back to the overall leader with no class leader', () => {
    // iRacing gives a lapped car a negative interval.
    expect(classMarginText(raw(-1, 18), raw(125_000, 20), 20)).toBe('-2L');
    expect(classMarginText(raw(200_000, 20), null, 20)).toBe(formatMargin(200_000, 20, 20));
    expect(classLeaders([scored('g1', GAMMA, 2, true)]).has(`7:1:${GAMMA}`)).toBe(false);
  });

  it('sorts margins: seconds by value, laps down after every timed gap, the leader last', () => {
    expect(marginSortValue('7.500')).toBe(7.5);
    expect(marginSortValue('-2L')).toBe(1_000_002);
    expect(marginSortValue('—')).toBeNull();
  });
});
