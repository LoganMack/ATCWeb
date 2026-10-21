import { describe, expect, it } from 'vitest';
import {
  computeSeasonStandingsRoundColumns,
  finalizeStandings,
  findFinalRoundSubsessionId,
  MIN_ROUNDS_FOR_DROPS,
  seasonDropWeeks,
  type StandingsAccum,
} from '../../src/lib/results/standingsCore';
import type { DriverBasic } from '../../src/lib/results/rows';
import { resolveSeasonRuleset, type Season } from '../../src/lib/db/seasons';
import { totalAsOf } from '../../src/lib/seasonTotals';
import {
  buildContext,
  exhibitionIds,
  expected,
  inputs,
  poolFor,
  season,
  standingsFor,
} from '../golden/atc17';

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('totalAsOf', () => {
  it('drops nothing while n is below minDropRounds', () => {
    const r = totalAsOf([10, 20, 30, 40], 4, 2, 5, true);
    expect(r.total).toBe(100);
    expect(sorted(r.dropped)).toEqual([]);
  });

  it('starts dropping once n equals minDropRounds', () => {
    // 10 + 50 + 20 + 40 + 30, dropping 10 (index 0) and 20 (index 2).
    const r = totalAsOf([10, 50, 20, 40, 30], 5, 2, 5, true);
    expect(r.total).toBe(120);
    expect(sorted(r.dropped)).toEqual([0, 2]);
  });

  it('counts only the first n columns', () => {
    const r = totalAsOf([10, 50, 20, 40, 30, 99, 99], 5, 2, 5, true);
    expect(r.total).toBe(120);
  });

  it('counts a null (no race) as zero, so it drops first', () => {
    const r = totalAsOf([null, 50, 20, 40, 30], 5, 2, 5, true);
    expect(r.total).toBe(120);
    expect(sorted(r.dropped)).toEqual([0, 2]);
  });

  it('keeps at least one round when there are more drops than rounds', () => {
    // 9 drops over 5 columns: 4 drop, the best (50) stays.
    expect(totalAsOf([10, 20, 30, 40, 50], 5, 9, 5, true)).toEqual({
      total: 50,
      dropped: new Set([0, 1, 2, 3]),
    });
    // With the final column protected it is the one kept, even though it is the lowest.
    expect(totalAsOf([50, 40, 30, 20, 10], 5, 9, 5, false)).toEqual({
      total: 10,
      dropped: new Set([0, 1, 2, 3]),
    });
  });

  it('always counts column n-1 when the final round may not be dropped', () => {
    // Column 4 scored 5, the lowest; it stays and 30 and 20 drop: 5 + 50 + 40.
    const r = totalAsOf([50, 40, 30, 20, 5], 5, 2, 5, false);
    expect(r.total).toBe(95);
    expect(sorted(r.dropped)).toEqual([2, 3]);
    // Below minDropRounds the protection changes nothing.
    expect(totalAsOf([10, 20, 30], 3, 2, 5, false).total).toBe(60);
  });

  it('drops the higher index when two columns score the same', () => {
    const r = totalAsOf([50, 20, 20, 40, 30], 5, 1, 5, true);
    expect(r.total).toBe(140);
    expect(sorted(r.dropped)).toEqual([2]);
  });
});

/**
 * Parity with finalizeStandings (BR3.3), asserted only under its precondition: every round of the
 * view's pool is a column (n = number of columns), and the season's final round is the last column.
 * A failure here is a finding for the owner and U6; neither implementation is changed to make it pass.
 */
describe('totalAsOf parity with finalizeStandings', () => {
  function accum(roundPoints: Map<number, number>): StandingsAccum {
    return {
      starts: roundPoints.size,
      subsessionIds: new Set(roundPoints.keys()),
      poleSubsessionIds: new Set(),
      wins: 0,
      podiums: 0,
      top5s: 0,
      top10s: 0,
      lapsLed: 0,
      laps: 0,
      roundPoints,
      roundStats: new Map(),
    };
  }
  const handSeason = { extra_drop_weeks: 0 } as Season;
  const handDriver = { id: 'd1', name: 'd1' } as DriverBasic;

  // Columns are rounds 11..15 in order; round 15 is the final round. Missed rounds are absent.
  // The last value is the total worked out by hand.
  const handCases: [string, Record<number, number>, boolean, number][] = [
    ['final round protected and lowest', { 11: 50, 12: 40, 13: 30, 14: 20, 15: 5 }, false, 95],
    ['missed rounds and ties, final droppable', { 11: 20, 13: 20, 14: 40, 15: 10 }, true, 80],
    ['missed final round, protected', { 11: 30, 12: 10, 13: 25, 14: 25 }, false, 55],
  ];
  it.each(handCases)('agrees on a hand case: %s', (_, points, canDropFinal, handTotal) => {
    const columns = [11, 12, 13, 14, 15];
    const [row] = finalizeStandings(
      new Map([['d1', accum(new Map(Object.entries(points).map(([k, v]) => [Number(k), v])))]]),
      new Map([['d1', handDriver]]),
      handSeason,
      new Set(columns),
      15,
      canDropFinal,
      2,
    );
    const perColumn = columns.map((id) => points[id] ?? null);
    expect(row.totalPoints).toBe(handTotal);
    expect(totalAsOf(perColumn, columns.length, 2, MIN_ROUNDS_FOR_DROPS, canDropFinal).total).toBe(handTotal);
  });

  it('agrees for every driver of every ATC17 view', () => {
    const context = buildContext();
    const drops = seasonDropWeeks(season, inputs.rulesets);
    const canDropFinal = resolveSeasonRuleset(season, inputs.rulesets)?.can_drop_final_round ?? false;
    const finalRound = findFinalRoundSubsessionId(context.seasonRounds, exhibitionIds);
    const mismatches: string[] = [];
    let checked = 0;
    for (const [name, view] of Object.entries(expected.views)) {
      const pool = poolFor(view.classId, context);
      const columns = computeSeasonStandingsRoundColumns(context.seasonRounds, pool, new Map());
      const precondition = columns.length === pool.size && columns.at(-1)?.subsessionId === finalRound;
      if (!precondition) continue;
      for (const s of standingsFor(view.classId, context)) {
        const points = columns.map((c) => s.roundCells.get(c.subsessionId)?.points ?? null);
        const total = totalAsOf(points, columns.length, drops, MIN_ROUNDS_FOR_DROPS, canDropFinal).total;
        checked++;
        if (total !== s.totalPoints)
          mismatches.push(`${name}, driver ${s.driver.id}: page ${total}, server ${s.totalPoints}`);
      }
    }
    // Every ATC17 view raced the final round, so the precondition holds and every driver is checked.
    expect(checked).toBe(Object.values(expected.views).reduce((n, v) => n + v.rows.length, 0));
    expect(mismatches).toEqual([]);
  });
});
