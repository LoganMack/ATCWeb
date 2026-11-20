/**
 * Points calculator parity (FR2.1, BR3.2): with no edits, the calculator's live totals, positions and dropped
 * rounds equal the Standings page's. The ATC17 golden season is cut after every round of every view: the
 * server's standings for that cut (finalizeStandings over the first n rounds, as tests/lib/seasonTotalsParity.test.ts
 * builds them) feed the calculator through its own builders, the later rounds become remaining rounds, and the
 * calculator must rank and drop exactly as the server did. The full season is also checked against the live
 * page's own standings builders.
 */
import { describe, expect, it } from 'vitest';
import { buildRounds, driverEntrants, assembleSeason, type CalendarSlot } from '../../src/lib/calculator/build';
import { computeContention } from '../../src/lib/calculator/contention';
import { resolveSeasonRuleset } from '../../src/lib/db/seasons';
import {
  computeSeasonStandingsRoundColumns,
  finalizeStandings,
  MIN_ROUNDS_FOR_DROPS,
  seasonDropWeeks,
  type DriverSeasonStanding,
  type StandingsAccum,
} from '../../src/lib/results/standingsCore';
import { buildContext, inputs, poolFor, season, standingsFor } from './atc17';

const context = buildContext();
const ruleset = resolveSeasonRuleset(season, inputs.rulesets);
const drops = seasonDropWeeks(season, inputs.rulesets);
const canDropFinal = ruleset?.can_drop_final_round ?? false;

/** The server's standings as of the first `n` columns (the page's "as of round n"). */
function serverAsOf(full: DriverSeasonStanding[], columns: number[], n: number): DriverSeasonStanding[] {
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
      roundStats: new Map(rounds.map((id) => [id, s.roundStats.get(id)!])),
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
  const base = drops - (season.extra_drop_weeks ?? 0);
  return finalizeStandings(accum, drivers, season, new Set(visible), visible[n - 1], canDropFinal, base);
}

/** The calculator's season for a cut: the first n columns run, the rest remaining. */
function calculatorAt(standings: DriverSeasonStanding[], columns: number[], n: number) {
  const slots: CalendarSlot[] = columns.map((id, i) => ({
    subsessionId: i < n ? id : null,
    format: 'endurance',
    races: 1,
    track: null,
  }));
  const rounds = buildRounds(slots, ruleset?.rules, 'overall');
  return assembleSeason({
    season: { id: season.id, name: season.name },
    championship: 'overall',
    rounds,
    entrants: driverEntrants(standings, rounds, slots),
    dropCount: drops,
    dropsFromRounds: MIN_ROUNDS_FOR_DROPS,
    canDropFinalRound: canDropFinal,
  });
}

/** What the comparison reads from a standings row: key, position, total, dropped column numbers (1-based). */
function serverRows(standings: DriverSeasonStanding[], columns: number[]) {
  return standings.map((s) => ({
    key: s.driver.id,
    position: s.position,
    total: s.totalPoints,
    dropped: columns.flatMap((id, i) => (s.roundCells.get(id)?.dropped ? [i + 1] : [])),
  }));
}

function calculatorRows(standings: DriverSeasonStanding[], columns: number[], n: number) {
  return computeContention(calculatorAt(standings, columns, n), []).map((r) => ({
    key: r.key,
    position: r.position,
    total: r.countedTotal,
    // A dropped round the driver never raced has no matrix cell on the Standings page either.
    dropped: r.droppedRounds.filter((round) => r.roundPoints[round - 1] !== null),
  }));
}

describe('points calculator parity with the Standings page (ATC17)', () => {
  const views = [null, ...inputs.classes.map((c) => c.id)];

  it.each(views)('class %s: every "as of" cut ranks, totals and drops as the server does', (classId) => {
    const full = standingsFor(classId, context);
    const columns = computeSeasonStandingsRoundColumns(context.seasonRounds, poolFor(classId, context), new Map()).map(
      (c) => c.subsessionId,
    );
    // ATC17 drivers are all visible, so the calculator keys are the driver ids.
    expect(full.every((s) => !s.driver.is_hidden)).toBe(true);
    expect(columns.length).toBeGreaterThan(MIN_ROUNDS_FOR_DROPS);
    for (let n = 1; n <= columns.length; n++) {
      const server = serverAsOf(full, columns, n);
      expect(calculatorRows(server, columns, n), `class ${classId}, as of round ${n}`).toEqual(
        serverRows(server, columns),
      );
    }
  });

  it.each(views)('class %s: the full season equals the live standings builders', (classId) => {
    const full = standingsFor(classId, context);
    const columns = computeSeasonStandingsRoundColumns(context.seasonRounds, poolFor(classId, context), new Map()).map(
      (c) => c.subsessionId,
    );
    expect(calculatorRows(full, columns, columns.length)).toEqual(serverRows(full, columns));
  });
});
