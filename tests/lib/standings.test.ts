/**
 * Standings: the pure helpers behind computeSeasonStandings / computeOverallSeasonStandings.
 * Every season here is hand-built and every expected value is worked out by hand from the rule
 * (points tables in src/lib/penalties.ts; drop weeks and tiebreakers in finalizeStandings' doc comment).
 */
import { describe, expect, it } from 'vitest';
import { buildOverallSeasonStandings, buildSeasonStandings } from '../../src/lib/results/standings';
import { buildSeasonOverallContext } from '../../src/lib/results/seasonContext';
import {
  finalizeStandings,
  findFinalRoundSubsessionId,
  type DriverSeasonStanding,
  type StandingsAccum,
} from '../../src/lib/results/standingsCore';
import type {
  CuratedRaceResultRow,
  DriverBasic,
  RaceScoreOverallRow,
  RaceScoreRow,
  RawLapStatsRow,
  RoundSummary,
} from '../../src/lib/results/rows';
import type { Lookup } from '../../src/lib/db/lookups';
import type { Penalty } from '../../src/lib/db/penalties';
import type { ScoringRuleset, Season } from '../../src/lib/db/seasons';

const ALPHA = 1;
const GAMMA = 2;
const DELTA = 3;
const CLASSES: Lookup[] = [
  { id: ALPHA, name: 'Alpha', sort_order: 1 },
  { id: GAMMA, name: 'Gamma', sort_order: 2 },
  { id: DELTA, name: 'Delta', sort_order: 3 },
];

function season(over: Partial<Season> = {}): Season {
  return {
    id: 'season-99',
    number: 99,
    name: 'ATC99',
    logo_url: null,
    logo_url_light: null,
    start_date: null,
    end_date: null,
    is_current: false,
    extra_drop_weeks: 0,
    scoring_ruleset_id: 'rs',
    gamma_enabled: true,
    delta_enabled: true,
    delta_team_enabled: false,
    ...over,
  };
}

/** rules null: the fixed points tables apply (sprint P1 100, P2 95, P3 90) and drops.base falls back to 2. */
function ruleset(over: Partial<ScoringRuleset> = {}): ScoringRuleset {
  return {
    id: 'rs',
    name: 'rs',
    rules: null,
    is_default: true,
    can_drop_final_round: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function driver(id: string, custId: number | null = null, name = id): DriverBasic {
  return {
    id,
    name,
    car_number: null,
    photo_url: null,
    iracing_cust_id: custId,
    is_rookie: false,
    nationality_1: null,
    nationality_2: null,
    is_ai: false,
  };
}

function round(
  subsessionId: number,
  day: number,
  roundNumber: number | null = null,
  format: 'sprint' | 'endurance' | null = 'sprint',
): RoundSummary {
  return {
    subsession_id: subsessionId,
    season_id: 'season-99',
    start_time: `2026-01-${String(day).padStart(2, '0')}T20:00:00+00:00`,
    track_name: `Track ${subsessionId}`,
    season_label: null,
    round_number: roundNumber,
    format,
    strength_of_field: null,
    num_drivers: null,
  };
}

function penalty(over: Partial<Penalty> & { driver_id: string | null; subsession_id: number }): Penalty {
  return {
    id: `pen-${over.subsession_id}-${over.driver_id}`,
    race_number: 1,
    session_type: 'race',
    incident_number: null,
    lap: null,
    description: 'Test penalty',
    time_penalty_seconds: null,
    points_penalty: 0,
    penalty_points: 0,
    is_warning: false,
    created_at: '2026-01-01T00:00:00Z',
    offense_ids: [],
    involved_driver_ids: [],
    is_appealed: false,
    appeal_result: null,
    appeal_time_penalty_seconds: null,
    appeal_points_penalty: 0,
    appeal_penalty_points: 0,
    ...over,
  };
}

/** One driver's race, in database terms: a race_scores row plus its curated_race_results row. */
interface Entry {
  sub: number;
  race?: number;
  driver: string;
  cls: number;
  /** curated_race_results.finish_position (overall, pre-penalty). */
  finish: number;
  adjusted?: number | null;
  /** race_scores.scored_position; defaults to adjusted ?? finish. */
  scored?: number | null;
  fp?: number;
  cp?: number;
  finesse?: number;
  pole?: number;
  aggression?: number;
  deduction?: number;
  dsq?: boolean;
  start?: number;
  interval?: number;
  lapsLed?: number;
}

interface World {
  drivers: DriverBasic[];
  overall: RaceScoreOverallRow[];
  raw: CuratedRaceResultRow[];
  laps: RawLapStatsRow[];
  byClass: (classId: number) => RaceScoreRow[];
}

const LAPS = 10;
const AVG_LAP = 900000; // 90 s in ten-thousandths

/**
 * Builds the rows the standings code reads. Drivers get customer ids 1, 2, 3 ... in order of first
 * appearance, except those listed in `noCustId`, whose results carry an id no driver row has.
 * total_points is the generated column's sum (the other bonuses are 0 here). Unless given, the
 * gap to the leader is 1 s per place and every driver completes 10 laps at a 90 s average.
 */
function world(entries: Entry[], noCustId: string[] = []): World {
  const ids = [...new Set(entries.map((e) => e.driver))];
  const custOf = new Map(ids.map((id, i) => [id, noCustId.includes(id) ? 9000 + i : i + 1]));
  const drivers = ids.map((id) => driver(id, noCustId.includes(id) ? null : (custOf.get(id) as number)));
  const scoreRows = entries.map((e) => {
    const fp = e.fp ?? 0;
    const cp = e.cp ?? 0;
    const finesse = e.finesse ?? 0;
    const pole = e.pole ?? 0;
    const aggression = e.aggression ?? 0;
    const deduction = e.deduction ?? 0;
    return {
      cls: e.cls,
      score: {
        subsession_id: e.sub,
        race_number: e.race ?? 1,
        driver_id: e.driver,
        team_id: null,
        total_points: fp + cp + finesse + pole + aggression + deduction,
        class_points: cp,
        finesse_bonus: finesse,
        points_deduction: deduction,
        pole_bonus: pole,
        aggression_bonus: aggression,
        lap_led_bonus: 0,
        fewest_incidents_bonus: 0,
        fastest_lap_bonus: 0,
        sprint_sweep_bonus: 0,
        classified: true,
        dsq: e.dsq ?? false,
      } satisfies RaceScoreRow,
      overall: {
        subsession_id: e.sub,
        race_number: e.race ?? 1,
        driver_id: e.driver,
        class_id: e.cls,
        team_id: null,
        finish_points: fp,
        finesse_bonus: finesse,
        pole_bonus: pole,
        points_deduction: deduction,
        aggression_bonus: aggression,
        dsq: e.dsq ?? false,
        classified: true,
        scored_position: e.scored !== undefined ? e.scored : (e.adjusted ?? e.finish),
      } satisfies RaceScoreOverallRow,
    };
  });
  const raw = entries.map((e): CuratedRaceResultRow => ({
    subsession_id: e.sub,
    race_number: e.race ?? 1,
    cust_id: custOf.get(e.driver) as number,
    finish_position: e.finish,
    starting_position: e.start ?? e.finish,
    adjusted_position: e.adjusted ?? null,
    incidents: 0,
    laps_complete: LAPS,
    laps_led: e.lapsLed ?? 0,
    car_name: null,
    interval_ten_thousandths: e.interval ?? (e.finish - 1) * 10000,
  }));
  const laps = entries.map((e): RawLapStatsRow => ({
    subsession_id: e.sub,
    race_number: e.race ?? 1,
    cust_id: custOf.get(e.driver) as number,
    average_lap_ten_thousandths: AVG_LAP,
    best_lap_ten_thousandths: AVG_LAP - 10000,
  }));
  return {
    drivers,
    overall: scoreRows.map((r) => r.overall),
    raw,
    laps,
    byClass: (classId) => scoreRows.filter((r) => r.cls === classId).map((r) => r.score),
  };
}

interface Opts {
  rounds: RoundSummary[];
  penalties?: Penalty[];
  excluded?: number[];
}

/** Builds the context the way getSeasonOverallContext does: raw rows only for non-excluded rounds. */
function contextFor(w: World, o: Opts) {
  const excluded = new Set(o.excluded ?? []);
  return buildSeasonOverallContext(
    excluded,
    w.drivers,
    w.overall,
    w.raw.filter((r) => !excluded.has(r.subsession_id)),
    o.penalties ?? [],
    o.rounds,
    w.laps.filter((r) => !excluded.has(r.subsession_id)),
    null,
  );
}

function classStandings(w: World, classId: number, o: Opts): DriverSeasonStanding[] {
  const exhibitionIds = new Set(o.excluded ?? []);
  return buildSeasonStandings({
    season: season(),
    classId,
    scoresRaw: w.byClass(classId),
    drivers: w.drivers,
    exhibitionIds,
    classes: CLASSES,
    rulesets: [ruleset()],
    overallContext: contextFor(w, o),
  });
}

function overallStandings(w: World, o: Opts): DriverSeasonStanding[] {
  return buildOverallSeasonStandings({
    season: season(),
    drivers: w.drivers,
    exhibitionIds: new Set(o.excluded ?? []),
    rulesets: [ruleset()],
    overallContext: contextFor(w, o),
  });
}

const byDriver = (rows: DriverSeasonStanding[]) => new Map(rows.map((r) => [r.driver.id, r]));
const order = (rows: DriverSeasonStanding[]) => rows.map((r) => [r.position, r.driver.id, r.totalPoints]);

// ---------------------------------------------------------------------------
// finalizeStandings
// ---------------------------------------------------------------------------

interface AccumSpec {
  points: Record<number, number>;
  wins?: number;
  podiums?: number;
  top5s?: number;
  top10s?: number;
  poles?: number[];
  lapsLed?: number;
  laps?: number;
  /** Rounds attended; defaults to the rounds in `points`. */
  rounds?: number[];
}

function accum(spec: AccumSpec): StandingsAccum {
  const roundIds = spec.rounds ?? Object.keys(spec.points).map(Number);
  return {
    starts: roundIds.length,
    subsessionIds: new Set(roundIds),
    poleSubsessionIds: new Set(spec.poles ?? []),
    wins: spec.wins ?? 0,
    podiums: spec.podiums ?? 0,
    top5s: spec.top5s ?? 0,
    top10s: spec.top10s ?? 0,
    lapsLed: spec.lapsLed ?? 0,
    laps: spec.laps ?? 0,
    roundPoints: new Map(Object.entries(spec.points).map(([id, p]) => [Number(id), p])),
    roundStats: new Map(),
  };
}

function finalizeOne(
  points: Record<number, number>,
  pool: number[],
  finalRound: number | null = null,
  canDropFinalRound = true,
  baseDropWeeks = 2,
) {
  const [row] = finalizeStandings(
    new Map([['d1', accum({ points })]]),
    new Map([['d1', driver('d1')]]),
    season(),
    new Set(pool),
    finalRound,
    canDropFinalRound,
    baseDropWeeks,
  );
  const dropped = [...row.roundCells].filter(([, c]) => c.dropped).map(([id]) => id);
  return { total: row.totalPoints, dropped, cells: [...row.roundCells.keys()] };
}

describe('finalizeStandings', () => {
  it('counts every round when only 4 have been raced', () => {
    expect(finalizeOne({ 1: 10, 2: 20, 3: 30, 4: 40 }, [1, 2, 3, 4])).toEqual({
      total: 100,
      dropped: [],
      cells: [1, 2, 3, 4],
    });
  });

  it('drops the base 2 worst rounds once exactly 5 have been raced', () => {
    // 10 + 50 + 20 + 40 + 30, dropping 10 and 20.
    const r = finalizeOne({ 1: 10, 2: 50, 3: 20, 4: 40, 5: 30 }, [1, 2, 3, 4, 5]);
    expect(r.total).toBe(120);
    expect(r.dropped.sort()).toEqual([1, 3]);
  });

  it('adds the season’s extra drop weeks to the base', () => {
    const [row] = finalizeStandings(
      new Map([['d1', accum({ points: { 1: 10, 2: 50, 3: 20, 4: 40, 5: 30 } })]]),
      new Map([['d1', driver('d1')]]),
      season({ extra_drop_weeks: 1 }),
      new Set([1, 2, 3, 4, 5]),
    );
    // 3 drops: 10, 20 and 30 go; 50 + 40 stay.
    expect(row.totalPoints).toBe(90);
  });

  it('counts a missed round as 0 and drops it before any scored round', () => {
    // Round 5 was missed: the pool is 10, 20, 30, 40 and 0, so 0 and 10 drop.
    const r = finalizeOne({ 1: 10, 2: 20, 3: 30, 4: 40 }, [1, 2, 3, 4, 5]);
    expect(r.total).toBe(90);
    expect(r.dropped).toEqual([1]);
    expect(r.cells).toEqual([1, 2, 3, 4]);
  });

  it('drops the higher subsession id when two rounds score the same', () => {
    const r = finalizeOne({ 1: 50, 2: 20, 3: 20, 4: 40, 5: 30 }, [1, 2, 3, 4, 5], null, true, 1);
    expect(r.total).toBe(140);
    expect(r.dropped).toEqual([3]);
  });

  it('always counts the final round when it may not be dropped and is in the pool', () => {
    // Final round 5 scored 5, the lowest; it stays, and 30 and 20 drop from the rest: 5 + 50 + 40.
    const r = finalizeOne({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 5 }, [1, 2, 3, 4, 5], 5, false);
    expect(r.total).toBe(95);
    expect(r.dropped.sort()).toEqual([3, 4]);
  });

  it('drops freely when the protected final round is not in this pool', () => {
    // Final round 99 was not raced by this view: 50 + 40 + 30, dropping 20 and 5.
    const r = finalizeOne({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 5 }, [1, 2, 3, 4, 5], 99, false);
    expect(r.total).toBe(120);
    expect(r.dropped.sort()).toEqual([4, 5]);
  });

  it('can drop the final round when the ruleset allows it', () => {
    const r = finalizeOne({ 1: 50, 2: 40, 3: 30, 4: 20, 5: 5 }, [1, 2, 3, 4, 5], 5, true);
    expect(r.total).toBe(120);
    expect(r.dropped.sort()).toEqual([4, 5]);
  });

  it('keeps at least one round however many drops there are', () => {
    // 9 drops against 5 rounds: 4 drop, the best (50) is kept.
    const r = finalizeOne({ 1: 10, 2: 20, 3: 30, 4: 40, 5: 50 }, [1, 2, 3, 4, 5], null, true, 9);
    expect(r.total).toBe(50);
    expect(r.dropped.sort()).toEqual([1, 2, 3, 4]);
  });

  // Each tiebreaker in order: two drivers level on points and on every earlier tiebreaker; the one
  // ahead on this one ranks first even though "Aaron" sorts first by name.
  const tiebreakers: [string, Partial<AccumSpec>, Partial<AccumSpec>][] = [
    ['wins', { wins: 2 }, { wins: 1 }],
    ['podiums', { podiums: 3 }, { podiums: 2 }],
    ['top 5s', { top5s: 3 }, { top5s: 2 }],
    ['top 10s', { top10s: 3 }, { top10s: 2 }],
    ['poles', { poles: [1] }, { poles: [] }],
    ['laps led', { lapsLed: 5 }, { lapsLed: 4 }],
    ['laps', { laps: 30 }, { laps: 29 }],
    ['appearances', { rounds: [1, 2] }, { rounds: [1] }],
  ];
  it.each(tiebreakers)('breaks a points tie on %s', (_, ahead, behind) => {
    const rows = finalizeStandings(
      new Map([
        ['aaron', accum({ points: { 1: 50 }, ...behind })],
        ['zoe', accum({ points: { 1: 50 }, ...ahead })],
      ]),
      new Map([
        ['aaron', driver('aaron', null, 'Aaron')],
        ['zoe', driver('zoe', null, 'Zoe')],
      ]),
      season(),
      new Set([1, 2]),
    );
    expect(rows.map((r) => [r.position, r.driver.id])).toEqual([
      [1, 'zoe'],
      [2, 'aaron'],
    ]);
  });

  it('falls back to the display name (trailing digits removed) when everything else is level', () => {
    const rows = finalizeStandings(
      new Map([
        ['z', accum({ points: { 1: 50 } })],
        ['a', accum({ points: { 1: 50 } })],
      ]),
      new Map([
        ['z', driver('z', null, 'Zed')],
        ['a', driver('a', null, 'Amy2')],
      ]),
      season(),
      new Set([1]),
    );
    expect(rows.map((r) => r.driver.id)).toEqual(['a', 'z']);
  });

  it('skips a driver missing from the driver list', () => {
    const rows = finalizeStandings(
      new Map([
        ['known', accum({ points: { 1: 10 } })],
        ['gone', accum({ points: { 1: 90 } })],
      ]),
      new Map([['known', driver('known')]]),
      season(),
      new Set([1]),
    );
    expect(order(rows)).toEqual([[1, 'known', 10]]);
  });
});

// ---------------------------------------------------------------------------
// findFinalRoundSubsessionId
// ---------------------------------------------------------------------------

describe('findFinalRoundSubsessionId', () => {
  it('picks the latest round by start time', () => {
    expect(findFinalRoundSubsessionId([round(10, 1), round(30, 3), round(20, 2)], new Set())).toBe(30);
  });

  it('gives null when there are no eligible rounds', () => {
    expect(findFinalRoundSubsessionId([], new Set())).toBeNull();
    expect(findFinalRoundSubsessionId([round(10, 1)], new Set([10]))).toBeNull();
  });

  it('ignores an excluded round even when it is the latest', () => {
    expect(findFinalRoundSubsessionId([round(10, 1), round(20, 2), round(30, 3)], new Set([30]))).toBe(20);
  });

  it('breaks an equal start time on the higher round number', () => {
    expect(findFinalRoundSubsessionId([round(10, 5, 7), round(20, 5, 8), round(30, 5, 6)], new Set())).toBe(
      20,
    );
  });
});

// ---------------------------------------------------------------------------
// buildSeasonOverallContext
// ---------------------------------------------------------------------------

describe('buildSeasonOverallContext', () => {
  const rounds = [round(100, 1), round(200, 2)];

  it('builds the lookups from the season’s rows', () => {
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 2, fp: 95 },
    ]);
    const ctx = contextFor(w, { rounds });
    expect(ctx.overallScores).toHaveLength(2);
    expect([...ctx.custIdByDriverId]).toEqual([
      ['a1', 1],
      ['g1', 2],
    ]);
    expect(ctx.rawByKey.get('100:1:2')?.finish_position).toBe(2);
    expect(ctx.formatBySubsession.get(100)).toBe('sprint');
    expect(ctx.leaderStatsByRace.get('100:1')).toEqual({
      lapsComplete: LAPS,
      averageLapTenThousandths: AVG_LAP,
    });
    expect(ctx.seasonRounds).toBe(rounds);
  });

  it('gives a driver without an iRacing customer id no raw lookup', () => {
    const w = world(
      [
        { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100, lapsLed: 10 },
        { sub: 100, driver: 'nocust', cls: ALPHA, finish: 2, fp: 95, lapsLed: 3 },
      ],
      ['nocust'],
    );
    const ctx = contextFor(w, { rounds });
    expect(ctx.custIdByDriverId.has('nocust')).toBe(false);
    // Standings still count the driver's points, but find no laps for them.
    const rows = byDriver(overallStandings(w, { rounds }));
    expect(rows.get('nocust')).toMatchObject({ totalPoints: 95, laps: 0, lapsLed: 0 });
    expect(rows.get('a1')).toMatchObject({ totalPoints: 100, laps: LAPS, lapsLed: 10 });
  });

  it('makes no adjustments when there are no penalties', () => {
    const w = world([{ sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 }]);
    const ctx = contextFor(w, { rounds });
    expect(ctx.adjustments.size).toBe(0);
    expect(ctx.penalties).toEqual([]);
  });

  it('filters an excluded round out of overallScores', () => {
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 200, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
    ]);
    const ctx = contextFor(w, { rounds, excluded: [200] });
    expect(ctx.overallScores.map((s) => s.subsession_id)).toEqual([100]);
  });

  it('returns an empty context when every round is excluded', () => {
    const w = world([{ sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 }]);
    const ctx = contextFor(w, { rounds, excluded: [100] });
    expect(ctx.overallScores).toEqual([]);
    expect(ctx.seasonRounds).toEqual([]);
    expect(ctx.rawByKey.size).toBe(0);
    expect(ctx.custIdByDriverId.get('a1')).toBe(1);
  });

  it('records the overall adjustment a time penalty causes', () => {
    // g1 led a1 by 1 s; a 5 s penalty drops g1 behind, so a1 is P1 (100 pts) and g1 P2 (95).
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, fp: 100, cp: 4 },
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 2, fp: 95 },
    ]);
    const ctx = contextFor(w, {
      rounds,
      penalties: [penalty({ subsession_id: 100, driver_id: 'g1', time_penalty_seconds: 5 })],
    });
    expect(ctx.adjustments.get('100:1:a1')).toEqual({
      newPosition: 1,
      finishPoints: 100,
      pointsDeduction: 0,
      overallTotalPoints: 100,
    });
    expect(ctx.adjustments.get('100:1:g1')).toEqual({
      newPosition: 2,
      finishPoints: 95,
      pointsDeduction: 0,
      overallTotalPoints: 95,
    });
  });
});

// ---------------------------------------------------------------------------
// buildSeasonStandings (class view)
// ---------------------------------------------------------------------------

describe('buildSeasonStandings', () => {
  const rounds = [round(100, 1), round(200, 2)];

  it('ranks wins and podiums within the class by adjusted, else finish, position', () => {
    // Overall: a1 1st, g1 2nd, g2 3rd but officially moved to 7th, g3 4th, g4 5th.
    // Gamma order: g1, g3, g4, g2.
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 2, fp: 95, cp: 4 },
      { sub: 100, driver: 'g2', cls: GAMMA, finish: 3, adjusted: 7, fp: 90 },
      { sub: 100, driver: 'g3', cls: GAMMA, finish: 4, fp: 85, cp: 2 },
      { sub: 100, driver: 'g4', cls: GAMMA, finish: 5, fp: 81, cp: 1 },
    ]);
    const rows = classStandings(w, GAMMA, { rounds });
    expect(order(rows)).toEqual([
      [1, 'g1', 99],
      [2, 'g2', 90],
      [3, 'g3', 87],
      [4, 'g4', 82],
    ]);
    const s = byDriver(rows);
    expect([s.get('g1')!.wins, s.get('g1')!.podiums]).toEqual([1, 1]);
    expect([s.get('g3')!.wins, s.get('g3')!.podiums]).toEqual([0, 1]);
    expect([s.get('g4')!.wins, s.get('g4')!.podiums]).toEqual([0, 1]);
    expect([s.get('g2')!.wins, s.get('g2')!.podiums, s.get('g2')!.top5s]).toEqual([0, 0, 1]);
  });

  it('never ranks a disqualified driver, and the drivers behind move up', () => {
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, dsq: true },
      { sub: 100, driver: 'g2', cls: GAMMA, finish: 2, fp: 95, cp: 4 },
      { sub: 100, driver: 'g3', cls: GAMMA, finish: 3, fp: 90, cp: 2 },
    ]);
    const s = byDriver(classStandings(w, GAMMA, { rounds }));
    expect(s.get('g2')).toMatchObject({ wins: 1, podiums: 1, totalPoints: 99 });
    expect(s.get('g3')).toMatchObject({ wins: 0, podiums: 1, totalPoints: 92 });
    // The DSQ still counts as a start and an appearance.
    expect(s.get('g1')).toMatchObject({
      wins: 0,
      podiums: 0,
      top10s: 0,
      starts: 1,
      appearances: 1,
      totalPoints: 0,
    });
  });

  it('leaves excluded rounds out', () => {
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, fp: 50 },
      { sub: 200, driver: 'g1', cls: GAMMA, finish: 1, fp: 70 },
    ]);
    const [row] = classStandings(w, GAMMA, { rounds, excluded: [200] });
    expect(row).toMatchObject({ totalPoints: 50, starts: 1, appearances: 1 });
    expect([...row.roundCells.keys()]).toEqual([100]);
  });

  it('returns nothing when every one of the class’s rounds is excluded', () => {
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 200, driver: 'g1', cls: GAMMA, finish: 1, fp: 70 },
    ]);
    expect(classStandings(w, GAMMA, { rounds, excluded: [200] })).toEqual([]);
  });

  it('lowers a round’s points by a points deduction', () => {
    // g1: 100 + 4 class points - 10 = 94, now behind g2's 95 + 2 = 97; still the class winner.
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, fp: 100, cp: 4 },
      { sub: 100, driver: 'g2', cls: GAMMA, finish: 2, fp: 95, cp: 2 },
    ]);
    const rows = classStandings(w, GAMMA, {
      rounds,
      penalties: [penalty({ subsession_id: 100, driver_id: 'g1', points_penalty: 10 })],
    });
    expect(order(rows)).toEqual([
      [1, 'g2', 97],
      [2, 'g1', 94],
    ]);
    expect(byDriver(rows).get('g1')!.wins).toBe(1);
    expect(byDriver(rows).get('g1')!.roundCells.get(100)!.points).toBe(94);
  });

  describe('cross-class ripple', () => {
    // g1 (Gamma) led a1 by 1 s and a2 by 2 s. A 5 s penalty puts g1 behind both:
    // a1 P1 (100), a2 P2 (95), g1 P3 (90).
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, fp: 100, cp: 4 },
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 2, fp: 95 },
      { sub: 100, driver: 'a2', cls: ALPHA, finish: 3, fp: 90 },
    ]);
    const opts = {
      rounds,
      penalties: [penalty({ subsession_id: 100, driver_id: 'g1', time_penalty_seconds: 5 })],
    };

    it('raises the Alpha drivers to the overall-adjusted points', () => {
      expect(order(classStandings(w, ALPHA, opts))).toEqual([
        [1, 'a1', 100],
        [2, 'a2', 95],
      ]);
    });

    it('prices the penalised Gamma driver at the new overall position', () => {
      // 90 for P3 overall, plus the unchanged 4 class points (still 1st in Gamma).
      expect(order(classStandings(w, GAMMA, opts))).toEqual([[1, 'g1', 94]]);
    });
  });

  it('pins today’s behaviour: a Gamma driver does not pick up a ripple from a Delta penalty', () => {
    // d1 (Delta) led g1 by 1 s; a 5 s penalty makes g1 P1 overall (100 instead of 95).
    // The overall view shows that, but the Gamma class pass only reprocesses a race when a Gamma
    // driver was penalised, so g1's Gamma total stays at the raw 95 + 4 = 99, not 100 + 4 = 104.
    // Logged as a follow-up; not fixed in this unit (BR1.3).
    const w = world([
      { sub: 100, driver: 'd1', cls: DELTA, finish: 1, fp: 100, cp: 4 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 2, fp: 95, cp: 4 },
    ]);
    const opts = {
      rounds,
      penalties: [penalty({ subsession_id: 100, driver_id: 'd1', time_penalty_seconds: 5 })],
    };
    expect(order(classStandings(w, GAMMA, opts))).toEqual([[1, 'g1', 99]]);
    expect(order(classStandings(w, DELTA, opts))).toEqual([[1, 'd1', 99]]);
    expect(order(overallStandings(w, opts))).toEqual([
      [1, 'g1', 100],
      [2, 'd1', 95],
    ]);
  });

  it('takes Alpha points from the overall formula and Gamma points from total_points', () => {
    // a1: finish 100 + finesse 2 + pole 0 - 3 deduction = 99; the aggression bonus (2) is in
    // total_points (101) but not in the overall formula. g1: total_points 95 + 4 + 2 + 2 = 103.
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100, finesse: 2, aggression: 2, deduction: -3 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 2, fp: 95, cp: 4, finesse: 2, aggression: 2 },
    ]);
    expect(order(classStandings(w, ALPHA, { rounds }))).toEqual([[1, 'a1', 99]]);
    expect(order(classStandings(w, GAMMA, { rounds }))).toEqual([[1, 'g1', 103]]);
  });

  it('counts Alpha poles from the overall pole-sitter and Gamma poles from the class pole bonus', () => {
    // Race 1: a1 starts 1st overall with no pole bonus, a2 has a pole bonus but started 2nd.
    // Race 2: a2 starts 1st, which does not count (only race 1 has real qualifying).
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, start: 1, fp: 100 },
      { sub: 100, driver: 'a2', cls: ALPHA, finish: 2, start: 2, fp: 95, pole: 4 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 3, start: 3, fp: 90, pole: 4 },
      { sub: 100, driver: 'g2', cls: GAMMA, finish: 4, start: 4, fp: 85 },
      { sub: 100, race: 2, driver: 'a2', cls: ALPHA, finish: 1, start: 1, fp: 100 },
    ]);
    const alpha = byDriver(classStandings(w, ALPHA, { rounds }));
    expect([alpha.get('a1')!.poles, alpha.get('a2')!.poles]).toEqual([1, 0]);
    const gamma = byDriver(classStandings(w, GAMMA, { rounds }));
    expect([gamma.get('g1')!.poles, gamma.get('g2')!.poles]).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// buildOverallSeasonStandings
// ---------------------------------------------------------------------------

describe('buildOverallSeasonStandings', () => {
  const rounds = [round(100, 1), round(200, 2), round(300, 3)];

  it('combines a driver’s points from two classes into one row', () => {
    // d1 raced Delta in round 100 (P1, 100) and Gamma in round 200 (P2, 95).
    const w = world([
      { sub: 100, driver: 'd1', cls: DELTA, finish: 1, fp: 100 },
      { sub: 200, driver: 'x1', cls: GAMMA, finish: 1, fp: 100 },
      { sub: 200, driver: 'd1', cls: GAMMA, finish: 2, fp: 95 },
    ]);
    const s = byDriver(overallStandings(w, { rounds }));
    expect(s.get('d1')).toMatchObject({
      totalPoints: 195,
      appearances: 2,
      starts: 2,
      wins: 1,
      classId: GAMMA,
    });
    expect(s.size).toBe(2);
  });

  it('never counts class points', () => {
    const w = world([
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 1, fp: 100, cp: 4, finesse: 2, pole: 4 },
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 2, fp: 95, finesse: 2 },
    ]);
    expect(order(overallStandings(w, { rounds }))).toEqual([
      [1, 'g1', 106],
      [2, 'a1', 97],
    ]);
  });

  it('takes wins from scored_position, or from the penalised position', () => {
    // Round 100: a1 is P1 on scored_position. Round 200: g1 crossed the line first but a 5 s
    // penalty makes a1 P1.
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 100, driver: 'g1', cls: GAMMA, finish: 2, fp: 95 },
      { sub: 200, driver: 'g1', cls: GAMMA, finish: 1, fp: 100 },
      { sub: 200, driver: 'a1', cls: ALPHA, finish: 2, fp: 95 },
    ]);
    const s = byDriver(
      overallStandings(w, {
        rounds,
        penalties: [penalty({ subsession_id: 200, driver_id: 'g1', time_penalty_seconds: 5 })],
      }),
    );
    expect(s.get('a1')).toMatchObject({ wins: 2, totalPoints: 200 });
    expect(s.get('g1')).toMatchObject({ wins: 0, podiums: 2, totalPoints: 190 });
  });

  it('gives a disqualified driver no win even with a scored position', () => {
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, scored: 1, dsq: true },
      { sub: 100, driver: 'a2', cls: ALPHA, finish: 2, fp: 95 },
    ]);
    const s = byDriver(overallStandings(w, { rounds }));
    expect(s.get('a1')).toMatchObject({ wins: 0, podiums: 0, starts: 1 });
  });

  it('leaves excluded rounds out', () => {
    const w = world([
      { sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 200, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 },
      { sub: 200, driver: 'g1', cls: GAMMA, finish: 2, fp: 95 },
    ]);
    expect(order(overallStandings(w, { rounds, excluded: [200] }))).toEqual([[1, 'a1', 100]]);
  });

  it('returns nothing when every round is excluded', () => {
    const w = world([{ sub: 100, driver: 'a1', cls: ALPHA, finish: 1, fp: 100 }]);
    expect(overallStandings(w, { rounds, excluded: [100] })).toEqual([]);
  });

  it('applies drop weeks across the whole season pool', () => {
    // Five rounds, a1 raced four of them: the missed round (0) and the worst raced round (10) drop.
    const five = [round(1, 1), round(2, 2), round(3, 3), round(4, 4), round(5, 5)];
    const w = world([
      { sub: 1, driver: 'a1', cls: ALPHA, finish: 1, fp: 10 },
      { sub: 2, driver: 'a1', cls: ALPHA, finish: 1, fp: 20 },
      { sub: 3, driver: 'a1', cls: ALPHA, finish: 1, fp: 30 },
      { sub: 4, driver: 'a1', cls: ALPHA, finish: 1, fp: 40 },
      { sub: 5, driver: 'g1', cls: GAMMA, finish: 1, fp: 100 },
    ]);
    const s = byDriver(overallStandings(w, { rounds: five }));
    expect(s.get('a1')!.totalPoints).toBe(90);
  });
});
