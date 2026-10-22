/**
 * BR5.1: season totals live in one module (src/lib/seasonTotals.ts). The server (finalizeStandings)
 * and the standings page's "as of round N" script (totalAsOf + compareStandings) must agree, total
 * and order, for every round of the season.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSeasonStandingsRoundColumns,
  finalizeStandings,
  MIN_ROUNDS_FOR_DROPS,
  seasonDropWeeks,
  type DriverSeasonStanding,
  type StandingsAccum,
} from '../../src/lib/results/standingsCore';
import { compareStandings, dropWorstRounds, totalAsOf, type StandingKeys } from '../../src/lib/seasonTotals';
import { displayDriverName } from '../../src/lib/db/circuits';
import { resolveSeasonRuleset, type Season } from '../../src/lib/db/seasons';
import type { DriverBasic } from '../../src/lib/results/rows';
import { buildContext, inputs, poolFor, season, standingsFor } from '../golden/atc17';

const KEYS = ['wins', 'podiums', 'top5s', 'top10s', 'poles', 'lapsLed', 'laps'] as const;

/** The server's standings as of the first `n` columns: an accumulator cut to those rounds, finalised. */
function serverAsOf(
  full: DriverSeasonStanding[],
  columns: number[],
  n: number,
  drops: number,
  canDropFinal: boolean,
): [string, number][] {
  const visible = columns.slice(0, n);
  const accum = new Map<string, StandingsAccum>();
  for (const s of full) {
    const rounds = visible.filter((id) => s.roundCells.has(id));
    if (rounds.length === 0) continue;
    const a: StandingsAccum = {
      starts: 0,
      subsessionIds: new Set(rounds),
      poleSubsessionIds: new Set(rounds.filter((id) => (s.roundStats.get(id)?.poles ?? 0) > 0)),
      wins: 0,
      podiums: 0,
      top5s: 0,
      top10s: 0,
      lapsLed: 0,
      laps: 0,
      roundPoints: new Map(rounds.map((id) => [id, s.roundCells.get(id)!.points])),
      roundStats: new Map(),
    };
    for (const id of rounds) {
      const r = s.roundStats.get(id);
      a.wins += r?.wins ?? 0;
      a.podiums += r?.podiums ?? 0;
      a.top5s += r?.top5s ?? 0;
      a.top10s += r?.top10s ?? 0;
      a.lapsLed += r?.lapsLed ?? 0;
      a.laps += r?.laps ?? 0;
    }
    accum.set(s.driver.id, a);
  }
  const drivers = new Map(full.map((s) => [s.driver.id, s.driver]));
  // finalizeStandings adds the season's extra drop weeks to the ruleset base itself.
  const base = drops - (season.extra_drop_weeks ?? 0);
  return finalizeStandings(accum, drivers, season, new Set(visible), visible[n - 1], canDropFinal, base).map(
    (s) => [s.driver.id, s.totalPoints],
  );
}

/** The page script's standings as of the first `n` columns, from the same per-round cells. */
function pageAsOf(
  full: DriverSeasonStanding[],
  columns: number[],
  n: number,
  drops: number,
  canDropFinal: boolean,
): [string, number][] {
  const rows: StandingKeys[] = [];
  const ids = new Map<StandingKeys, string>();
  for (const s of full) {
    const visible = columns.slice(0, n);
    if (!visible.some((id) => s.roundCells.has(id))) continue;
    const points = columns.map((id) => s.roundCells.get(id)?.points ?? null);
    const keys: StandingKeys = {
      totalPoints: totalAsOf(points, n, drops, MIN_ROUNDS_FOR_DROPS, canDropFinal).total,
      wins: 0,
      podiums: 0,
      top5s: 0,
      top10s: 0,
      poles: 0,
      lapsLed: 0,
      laps: 0,
      appearances: visible.filter((id) => s.roundCells.has(id)).length,
      name: displayDriverName(s.driver.name),
    };
    for (const id of visible) {
      const r = s.roundStats.get(id);
      for (const k of KEYS) keys[k] += r?.[k] ?? 0;
    }
    rows.push(keys);
    ids.set(keys, s.driver.id);
  }
  return rows.sort(compareStandings).map((k) => [ids.get(k)!, k.totalPoints]);
}

describe('season totals parity', () => {
  it('agrees with the server on ATC17 for every "as of" round of every view', () => {
    const context = buildContext();
    const drops = seasonDropWeeks(season, inputs.rulesets);
    const canDropFinal = resolveSeasonRuleset(season, inputs.rulesets)?.can_drop_final_round ?? false;
    let compared = 0;
    for (const classId of [null, ...inputs.classes.map((c) => c.id)]) {
      const full = standingsFor(classId, context);
      const columns = computeSeasonStandingsRoundColumns(
        context.seasonRounds,
        poolFor(classId, context),
        new Map(),
      ).map((c) => c.subsessionId);
      for (let n = 1; n <= columns.length; n++) {
        expect(pageAsOf(full, columns, n, drops, canDropFinal), `class ${classId}, round ${n}`).toEqual(
          serverAsOf(full, columns, n, drops, canDropFinal),
        );
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('breaks a points tie the same way on both sides', () => {
    const tied = (wins: number, name: string): StandingKeys => ({
      totalPoints: 50,
      wins,
      podiums: 0,
      top5s: 0,
      top10s: 0,
      poles: 0,
      lapsLed: 0,
      laps: 0,
      appearances: 1,
      name,
    });
    const page = [tied(0, 'Aaron'), tied(1, 'Zoe'), tied(0, 'Amy')].sort(compareStandings).map((k) => k.name);
    expect(page).toEqual(['Zoe', 'Aaron', 'Amy']);

    const one = (wins: number) => ({
      starts: 1,
      subsessionIds: new Set([1]),
      poleSubsessionIds: new Set<number>(),
      wins,
      podiums: 0,
      top5s: 0,
      top10s: 0,
      lapsLed: 0,
      laps: 0,
      roundPoints: new Map([[1, 50]]),
      roundStats: new Map(),
    });
    const driver = (id: string, name: string) => ({ id, name }) as DriverBasic;
    const server = finalizeStandings(
      new Map([
        ['a', one(0)],
        ['z', one(1)],
        ['m', one(0)],
      ]),
      new Map([
        ['a', driver('a', 'Aaron')],
        ['z', driver('z', 'Zoe')],
        ['m', driver('m', 'Amy')],
      ]),
      { extra_drop_weeks: 0 } as Season,
      new Set([1]),
    ).map((s) => s.driver.name);
    expect(server).toEqual(page);
  });

  it('keeps one round when the drops equal the rounds counted', () => {
    const pool = [10, 20, 30].map((points, order) => ({ order, points }));
    expect(dropWorstRounds(pool, 3, null)).toEqual({ total: 30, dropped: new Set([0, 1]) });
    expect(totalAsOf([10, 20, 30], 3, 3, 1, true).total).toBe(30);
  });

  it('gives no total and no drops for no rounds', () => {
    expect(dropWorstRounds([], 2, null)).toEqual({ total: 0, dropped: new Set() });
    expect(totalAsOf([], 0, 2, 5, false)).toEqual({ total: 0, dropped: new Set() });
  });

  it('never drops a protected final round on either side', () => {
    // Round 5 is the final round and scores lowest; both sides keep it and drop 20 and 30.
    const points: Record<number, number> = { 1: 50, 2: 40, 3: 30, 4: 20, 5: 5 };
    const pool = Object.entries(points).map(([id, p]) => ({ order: Number(id), points: p }));
    const server = dropWorstRounds(pool, 2, 5);
    const page = totalAsOf(Object.values(points), 5, 2, 5, false);
    expect(server.total).toBe(95);
    expect(page.total).toBe(95);
    expect([...server.dropped].sort()).toEqual([3, 4]);
    expect([...page.dropped].sort()).toEqual([2, 3]);
  });
});
