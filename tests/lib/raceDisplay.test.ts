/**
 * Q9 A: the display formatter. Margins, intervals and race times are worked out from the same
 * inputs and formula the results page always used, so the text matches it exactly; positions come
 * from the view.
 */
import { describe, expect, it } from 'vitest';
import {
  fillUnrosteredPositions,
  formatRaceTime,
  overallRaceTimeTenThousandths,
  penalisedGaps,
  penalisedInterval,
  penalisedMargin,
  shownOldPosition,
  timePenaltiesByRaceDriver,
  type GapInput,
} from '../../src/lib/results/raceDisplay';

const LEADER = { lapsComplete: 20, averageLapTenThousandths: 900000 };
const row = (id: string, interval: number | null, laps = 20, avg: number | null = 900000): GapInput => ({
  id,
  intervalTenThousandths: interval,
  lapsComplete: laps,
  averageLapTenThousandths: avg,
});
const penalties = (byId: Record<string, number>) => (id: string) => (byId[id] ?? 0) * 10000;

describe('raceDisplay', () => {
  it('keeps an untouched lead-lap row on its own interval', () => {
    const gaps = penalisedGaps([row('a', 0), row('b', 65092), row('c', 120000)], penalties({ c: 5 }), LEADER);
    expect(penalisedMargin(gaps.get('b')!)).toBe('6.509');
    expect(penalisedMargin(gaps.get('c')!)).toBe('17.000');
    expect(penalisedInterval(gaps.get('c')!)).toBe(170000);
  });

  it('puts a lead-lap row one lap down when its penalty passes the leader’s average lap', () => {
    const gaps = penalisedGaps([row('a', 0), row('b', 850000)], penalties({ b: 10 }), LEADER);
    expect(gaps.get('b')).toEqual({ lapsDown: 1, gapTenThousandths: 50000 });
    expect(penalisedMargin(gaps.get('b')!)).toBe('-1L');
    expect(penalisedInterval(gaps.get('b')!)).toBe(-1);
  });

  it('counts several laps down from laps × average lap', () => {
    // 17 laps at 92 s against 20 at 90 s: 1,564 s against 1,800 s, never fewer than the 3 laps behind.
    const gaps = penalisedGaps([row('a', 0), row('c', -1, 17, 920000)], penalties({ c: 30 }), LEADER);
    expect(gaps.get('c')!.lapsDown).toBe(3);
    expect(penalisedMargin(gaps.get('c')!)).toBe('-3L');
  });

  it('leaves the raw margin when a laps-down row has no average lap', () => {
    const gaps = penalisedGaps([row('a', 0), row('d', -1, 18, null)], penalties({ d: 5 }), LEADER);
    expect(gaps.get('d')).toEqual({ lapsDown: 2, gapTenThousandths: null });
    expect(penalisedMargin({ lapsDown: 0, gapTenThousandths: null })).toBeNull();
  });

  it('re-zeroes to the leader after penalties, so a penalised winner who keeps the win reads a dash', () => {
    const gaps = penalisedGaps([row('a', 0), row('b', 65092)], penalties({ a: 3 }), LEADER);
    expect(penalisedMargin(gaps.get('a')!)).toBe('—');
    expect(penalisedMargin(gaps.get('b')!)).toBe('3.509');
  });

  it('shows the raw position struck through, and race times exactly as before, on the two reported rounds', () => {
    expect(shownOldPosition(9, 2)).toBe(2);
    expect(shownOldPosition(3, 3)).toBeNull();
    expect(shownOldPosition(null, 3)).toBeNull();
    // Round 77095150, race 1, the P10 finisher with a 10 s penalty: 27 laps at 138.2512 s + 10 s.
    // The view stores 3,742,802 ms (leader's time plus interval); the page shows laps × average lap.
    expect(formatRaceTime(overallRaceTimeTenThousandths(27, 1382512, 10))).toBe('62:22.782');
    // Round 74271017, race 1, P2 moved to P9 by a 10 s penalty: 14 laps at 90.2451 s + 10 s (view: 1,273,433 ms).
    expect(formatRaceTime(overallRaceTimeTenThousandths(14, 902451, 10))).toBe('21:13.431');
    // An unpenalised row, or no penalty visible, is laps × average lap alone; no average lap shows a dash.
    expect(formatRaceTime(overallRaceTimeTenThousandths(14, 902451, null))).toBe('21:03.431');
    expect(formatRaceTime(overallRaceTimeTenThousandths(14, null, 10))).toBe('—');
  });

  it('sums a driver’s effective time penalties per race, qualifying ones on race 1', () => {
    const p = (over: Partial<Parameters<typeof timePenaltiesByRaceDriver>[0][number]>) => ({
      race_number: 1,
      driver_id: 'd1',
      session_type: 'race' as const,
      time_penalty_seconds: null,
      points_penalty: 0,
      penalty_points: 0,
      is_warning: false,
      is_appealed: false,
      appeal_time_penalty_seconds: null,
      appeal_points_penalty: 0,
      appeal_penalty_points: 0,
      ...over,
    });
    const byKey = timePenaltiesByRaceDriver([
      p({ time_penalty_seconds: 5 }),
      p({ session_type: 'qualifying', race_number: 0, time_penalty_seconds: 3 }),
      p({ race_number: 2, is_appealed: true, time_penalty_seconds: 10, appeal_time_penalty_seconds: 2 }),
      p({ race_number: 2, driver_id: 'd2', points_penalty: 4 }),
      p({ driver_id: null, time_penalty_seconds: 30 }),
    ]);
    expect(Object.fromEntries(byKey)).toEqual({ '1:d1': 8, '2:d1': 2, '2:d2': 0 });
  });
});

describe('fillUnrosteredPositions', () => {
  it('gives unrostered entrants the positions the rostered rows leave free, in raw order', () => {
    // Rostered final positions 1, 2, 4, 5, 7: the two unrostered entrants take 3 and 6.
    expect(fillUnrosteredPositions([1, 2, 4, 5, 7], 2)).toEqual([3, 6]);
  });

  it('keeps raw positions when nothing moved, and continues past the rostered rows', () => {
    expect(fillUnrosteredPositions([1, 3], 1)).toEqual([2]);
    expect(fillUnrosteredPositions([1, 2], 2)).toEqual([3, 4]);
    expect(fillUnrosteredPositions([], 0)).toEqual([]);
  });
});
