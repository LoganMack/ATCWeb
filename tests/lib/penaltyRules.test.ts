/**
 * Penalty rules that stay in TypeScript after the scoring moved into the database: the appeal-aware
 * effective values the pages display, and the season penalty-point (PP) and probation tally. Race
 * and season scoring is covered by supabase/checks/scoring-fixtures.sql. Cases live in
 * tests/fixtures/penalty-rules/<function>/<case>.json.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPenaltyPointsToDriver,
  computeRoundPPSummary,
  computeSeasonPPState,
  countWarnings,
  isOnProbationNow,
  type DriverPPState,
} from '../../src/lib/penalties/penaltyPoints';
import {
  effectivePenaltyPoints,
  effectivePointsPenalty,
  effectiveTimePenaltySeconds,
  scoringRaceNumber,
} from '../../src/lib/penalties/effective';
import { loadPenaltyCases, toPenalties, type PenaltyDbRow } from './penaltyFixtures';

const named = <T extends { file: string; description: string }>(cases: T[]) =>
  cases.map((c) => [`${c.file}: ${c.description}`, c] as const);

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

describe('scoringRaceNumber', () => {
  it('keeps a race penalty on its own race', () => {
    expect(scoringRaceNumber({ session_type: 'race', race_number: 2 })).toBe(2);
  });

  it('puts a qualifying or practice penalty (stored as race 0) on race 1', () => {
    expect(scoringRaceNumber({ session_type: 'qualifying', race_number: 0 })).toBe(1);
    expect(scoringRaceNumber({ session_type: 'practice', race_number: 0 })).toBe(1);
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
