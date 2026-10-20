import { describe, expect, it } from 'vitest';
import {
  applyPenaltiesToRoundResults,
  applyPenaltyPointsToDriver,
  classPointsForPosition,
  computeRoundPPSummary,
  computeSeasonClassAdjustments,
  computeSeasonOverallAdjustments,
  computeSeasonPPState,
  countWarnings,
  effectivePenaltyPoints,
  effectivePointsPenalty,
  effectiveTimePenaltySeconds,
  finishPointsForPosition,
  isOnProbationNow,
  reorderByTimePenalty,
  resolvePointsTables,
  sumPenaltiesByRaceDriver,
  type DriverPPState,
  type Format,
  type Positionable,
} from '../../src/lib/penalties';
import {
  bySubsession,
  loadPenaltyCases,
  toLeaderStatsByRace,
  toPenalties,
  toRoundResults,
  toSeasonClassScoreRows,
  toSeasonScoreRows,
  type PenaltyDbRow,
  type ResultDbRow,
} from './penaltyFixtures';

const named = <T extends { file: string; description: string }>(cases: T[]) =>
  cases.map((c) => [`${c.file}: ${c.description}`, c] as const);

describe('finishPointsForPosition', () => {
  type Input = { rows: { format: Format; position: number }[] };
  it.each(named(loadPenaltyCases<Input, { points: number[] }>('finishPointsForPosition')))('%s', (_, c) => {
    expect(c.input.rows.map((r) => finishPointsForPosition(r.format, r.position))).toEqual(c.expected.points);
  });
});

describe('classPointsForPosition', () => {
  type Input = {
    rows: { format: Format; class_position: number | null; awards_class_points: boolean }[];
  };
  it.each(named(loadPenaltyCases<Input, { points: number[] }>('classPointsForPosition')))('%s', (_, c) => {
    expect(
      c.input.rows.map((r) => classPointsForPosition(r.format, r.class_position, r.awards_class_points)),
    ).toEqual(c.expected.points);
  });
});

describe('resolvePointsTables', () => {
  type Input = { rules: unknown; format: Format; race_number: number; subsession_id: number };
  it.each(named(loadPenaltyCases<Input>('resolvePointsTables')))('%s', (_, c) => {
    const { rules, format, race_number, subsession_id } = c.input;
    expect(resolvePointsTables(rules, format, race_number, subsession_id)).toEqual(c.expected);
  });
});

describe('effectiveTimePenaltySeconds / effectivePointsPenalty / effectivePenaltyPoints', () => {
  type Expected = { time_penalty_seconds: number | null; points_penalty: number; penalty_points: number };
  it.each(named(loadPenaltyCases<{ penalty: PenaltyDbRow }, Expected>('effectivePenaltyValues')))(
    '%s',
    (_, c) => {
      const [p] = toPenalties([c.input.penalty]);
      expect({
        time_penalty_seconds: effectiveTimePenaltySeconds(p),
        points_penalty: effectivePointsPenalty(p),
        penalty_points: effectivePenaltyPoints(p),
      }).toEqual(c.expected);
    },
  );
});

describe('reorderByTimePenalty', () => {
  type Input = { race_number: number; rows: ResultDbRow[]; penalties: PenaltyDbRow[] };
  type Expected = { positions: Record<string, Record<string, unknown>>; absent?: string[] };
  it.each(named(loadPenaltyCases<Input, Expected>('reorderByTimePenalty')))('%s', (_, c) => {
    const rows: Positionable[] = c.input.rows.map((r) => ({
      driverId: r.driver_id,
      position: r.scored_position,
      intervalTenThousandths: r.interval_ten_thousandths ?? null,
      lapsComplete: r.laps_complete ?? null,
      averageLapTenThousandths: r.average_lap_ten_thousandths ?? null,
    }));
    const leaderRow = c.input.rows.find((r) => r.finish_position === 1);
    const ranked = reorderByTimePenalty(
      rows,
      c.input.race_number,
      sumPenaltiesByRaceDriver(toPenalties(c.input.penalties)),
      {
        lapsComplete: leaderRow?.laps_complete ?? null,
        averageLapTenThousandths: leaderRow?.average_lap_ten_thousandths ?? null,
      },
    );
    for (const [driverId, expected] of Object.entries(c.expected.positions)) {
      expect(ranked.get(driverId), driverId).toMatchObject(expected);
    }
    expect(ranked.size).toBe(Object.keys(c.expected.positions).length);
    for (const driverId of c.expected.absent ?? []) expect(ranked.has(driverId), driverId).toBe(false);
  });
});

describe('applyPenaltiesToRoundResults', () => {
  type Input = {
    subsession_id: number;
    format: Format | null;
    rules: unknown;
    class_points_eligible: Record<string, boolean>;
    rows: ResultDbRow[];
    penalties: PenaltyDbRow[];
  };
  type RowExpectations = Record<string, Record<string, Record<string, unknown>>>;
  type Expected = {
    unchanged?: boolean;
    overall?: RowExpectations;
    byClass?: Record<string, RowExpectations>;
  };

  it.each(named(loadPenaltyCases<Input, Expected>('applyPenaltiesToRoundResults')))('%s', (_, c) => {
    const results = toRoundResults(c.input.rows);
    const eligible = new Map(
      Object.entries(c.input.class_points_eligible).map(([id, v]) => [Number(id), v] as const),
    );
    const out = applyPenaltiesToRoundResults(
      results,
      toPenalties(c.input.penalties),
      c.input.format,
      eligible,
      c.input.rules,
      c.input.subsession_id,
    );

    if (c.expected.unchanged) {
      expect(out).toBe(results);
      return;
    }
    for (const [race, drivers] of Object.entries(c.expected.overall ?? {})) {
      const rows = out.overall.get(Number(race)) ?? [];
      for (const [driverId, expected] of Object.entries(drivers)) {
        expect(
          rows.find((r) => r.driver.id === driverId),
          `overall race ${race} ${driverId}`,
        ).toMatchObject(expected);
      }
    }
    for (const [classId, races] of Object.entries(c.expected.byClass ?? {})) {
      for (const [race, drivers] of Object.entries(races)) {
        const rows = out.byClass.get(Number(classId))?.get(Number(race)) ?? [];
        for (const [driverId, expected] of Object.entries(drivers)) {
          expect(
            rows.find((r) => r.driver.id === driverId),
            `class ${classId} race ${race} ${driverId}`,
          ).toMatchObject(expected);
        }
      }
    }
  });
});

describe('computeSeasonOverallAdjustments', () => {
  type Input = { format: Format | null; rules: unknown; rows: ResultDbRow[]; penalties: PenaltyDbRow[] };
  it.each(
    named(
      loadPenaltyCases<Input, { adjustments: Record<string, unknown> }>('computeSeasonOverallAdjustments'),
    ),
  )('%s', (_, c) => {
    const out = computeSeasonOverallAdjustments(
      toSeasonScoreRows(c.input.rows),
      toPenalties(c.input.penalties),
      bySubsession(c.input.rows, c.input.format),
      bySubsession(c.input.rows, c.input.rules),
    );
    expect(Object.fromEntries(out)).toEqual(c.expected.adjustments);
  });
});

describe('computeSeasonClassAdjustments', () => {
  type Input = {
    format: Format | null;
    rules: unknown;
    class_id: number;
    awards_class_points: boolean;
    rows: ResultDbRow[];
    penalties: PenaltyDbRow[];
  };
  it.each(
    named(loadPenaltyCases<Input, { adjustments: Record<string, unknown> }>('computeSeasonClassAdjustments')),
  )('%s', (_, c) => {
    const penalties = toPenalties(c.input.penalties);
    const formats = bySubsession(c.input.rows, c.input.format);
    const rules = bySubsession(c.input.rows, c.input.rules);
    const overall = computeSeasonOverallAdjustments(
      toSeasonScoreRows(c.input.rows),
      penalties,
      formats,
      rules,
    );
    const out = computeSeasonClassAdjustments(
      toSeasonClassScoreRows(c.input.rows, c.input.class_id),
      penalties,
      formats,
      overall,
      toLeaderStatsByRace(c.input.rows),
      c.input.awards_class_points,
      rules,
    );
    expect(Object.fromEntries(out)).toEqual(c.expected.adjustments);
  });
});

describe('applyPenaltyPointsToDriver', () => {
  type Input = {
    driver: DriverPPState;
    awarded_points: number;
    is_currently_on_probation: boolean;
    today: string;
  };
  it.each(named(loadPenaltyCases<Input>('applyPenaltyPointsToDriver')))('%s', (_, c) => {
    const { driver, awarded_points, is_currently_on_probation, today } = c.input;
    expect(
      applyPenaltyPointsToDriver(driver, awarded_points, is_currently_on_probation, new Date(today)),
    ).toEqual(c.expected);
  });
});

describe('isOnProbationNow', () => {
  type Input = {
    driver: { on_probation: boolean; probation_started_at: string | null };
    events: { event_date: string }[];
    today: string;
    probation_days: number;
    probation_rounds: number;
  };
  it.each(named(loadPenaltyCases<Input, { on_probation: boolean }>('isOnProbationNow')))('%s', (_, c) => {
    const { driver, events, today, probation_days, probation_rounds } = c.input;
    expect(isOnProbationNow(driver, events, new Date(today), probation_days, probation_rounds)).toBe(
      c.expected.on_probation,
    );
  });
});

type PPDriver = { penalty_points_max: number; on_probation: boolean; probation_started_at: string | null };

describe('computeSeasonPPState', () => {
  type Input = { driver: PPDriver; penalties: PenaltyDbRow[]; events: { event_date: string }[] };
  it.each(named(loadPenaltyCases<Input>('computeSeasonPPState')))('%s', (_, c) => {
    expect(computeSeasonPPState(c.input.driver, toPenalties(c.input.penalties), c.input.events)).toEqual(
      c.expected,
    );
  });
});

describe('computeRoundPPSummary', () => {
  type Input = {
    driver: PPDriver;
    earlier_penalties: PenaltyDbRow[];
    round_penalties: PenaltyDbRow[];
    events: { event_date: string }[];
  };
  it.each(named(loadPenaltyCases<Input>('computeRoundPPSummary')))('%s', (_, c) => {
    expect(
      computeRoundPPSummary(
        c.input.driver,
        toPenalties(c.input.earlier_penalties),
        toPenalties(c.input.round_penalties),
        c.input.events,
      ),
    ).toEqual(c.expected);
  });
});

describe('countWarnings', () => {
  it.each(named(loadPenaltyCases<{ penalties: PenaltyDbRow[] }, { warnings: number }>('countWarnings')))(
    '%s',
    (_, c) => {
      expect(countWarnings(toPenalties(c.input.penalties))).toBe(c.expected.warnings);
    },
  );
});
