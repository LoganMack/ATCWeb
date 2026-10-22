/**
 * Shared test inputs written in database column names.
 *
 * loadPenaltyCases reads tests/fixtures/penalty-rules/<function>/<case>.json (the penalty rules still
 * in TypeScript: effective values, penalty points and probation). toPenalties maps penalties rows,
 * and toRoundResults builds a RoundResults from one row per driver's race (the race result and its
 * stored points; omitted columns take the defaults), for the results page's display tests.
 */
import type { PenaltyLike } from '../../src/lib/penalties/effective';
import type { DriverBasic } from '../../src/lib/results/rows';
import type { RaceResultRow, RoundResults } from '../../src/lib/results/roundResults';

// Bundled by Vite's glob import, so the tests need no Node file-system access.
const FIXTURES = import.meta.glob('../fixtures/penalty-rules/*/*.json', { eager: true, import: 'default' });

export interface PenaltyCase<I = Record<string, unknown>, E = Record<string, unknown>> {
  file: string;
  description: string;
  rule_ref: string;
  input: I;
  expected: E;
}

/** Every case for one function, in file-name order; throws when a file is missing a required key. */
export function loadPenaltyCases<I = Record<string, unknown>, E = Record<string, unknown>>(
  fn: string,
): PenaltyCase<I, E>[] {
  const prefix = `../fixtures/penalty-rules/${fn}/`;
  const paths = Object.keys(FIXTURES)
    .filter((p) => p.startsWith(prefix))
    .sort();
  if (paths.length === 0) throw new Error(`No penalty fixtures in tests/fixtures/penalty-rules/${fn}/`);
  return paths.map((path) => {
    const file = path.slice(prefix.length);
    const parsed = FIXTURES[path] as Partial<PenaltyCase<I, E>>;
    for (const key of ['description', 'rule_ref', 'input', 'expected'] as const) {
      if (parsed[key] === undefined) throw new Error(`${fn}/${file} has no "${key}"`);
    }
    return { ...(parsed as PenaltyCase<I, E>), file };
  });
}

/** A penalties row; omitted columns take the table defaults. */
export interface PenaltyDbRow {
  id?: string;
  subsession_id?: number;
  race_number?: number;
  session_type?: 'race' | 'qualifying' | 'practice';
  driver_id: string | null;
  time_penalty_seconds?: number | null;
  points_penalty?: number;
  penalty_points?: number;
  is_warning?: boolean;
  created_at?: string;
  is_appealed?: boolean;
  appeal_time_penalty_seconds?: number | null;
  appeal_points_penalty?: number;
  appeal_penalty_points?: number;
}

export type MappedPenalty = PenaltyLike & {
  id: string;
  subsession_id: number;
  race_number: number;
  session_type: 'race' | 'qualifying' | 'practice';
  driver_id: string | null;
  is_warning: boolean;
  created_at: string;
};

export function toPenalties(rows: PenaltyDbRow[] = []): MappedPenalty[] {
  return rows.map((r, i) => ({
    id: r.id ?? `p${i + 1}`,
    subsession_id: r.subsession_id ?? 100,
    race_number: r.race_number ?? 1,
    session_type: r.session_type ?? 'race',
    driver_id: r.driver_id,
    time_penalty_seconds: r.time_penalty_seconds ?? null,
    points_penalty: r.points_penalty ?? 0,
    penalty_points: r.penalty_points ?? 0,
    is_warning: r.is_warning ?? false,
    created_at: r.created_at ?? '2026-01-01T00:00:00Z',
    is_appealed: r.is_appealed ?? false,
    appeal_time_penalty_seconds: r.appeal_time_penalty_seconds ?? null,
    appeal_points_penalty: r.appeal_points_penalty ?? 0,
    appeal_penalty_points: r.appeal_penalty_points ?? 0,
  }));
}

/** One driver's race: its stored points plus the curated_race_results columns the display reads. */
export interface ResultDbRow {
  subsession_id?: number;
  race_number?: number;
  driver_id: string;
  class_id: number;
  scored_position: number | null;
  finish_points?: number;
  class_points?: number;
  finesse_bonus?: number;
  pole_bonus?: number;
  aggression_bonus?: number;
  lap_led_bonus?: number;
  fewest_incidents_bonus?: number;
  fastest_lap_bonus?: number;
  sprint_sweep_bonus?: number;
  points_deduction?: number;
  classified?: boolean;
  dsq?: boolean;
  finish_position: number;
  adjusted_position?: number | null;
  interval_ten_thousandths?: number | null;
  laps_complete?: number | null;
  average_lap_ten_thousandths?: number | null;
}

type FilledRow = Required<ResultDbRow> & { total_points: number };

function fill(r: ResultDbRow): FilledRow {
  const filled = {
    subsession_id: r.subsession_id ?? 100,
    race_number: r.race_number ?? 1,
    driver_id: r.driver_id,
    class_id: r.class_id,
    scored_position: r.scored_position,
    finish_points: r.finish_points ?? 0,
    class_points: r.class_points ?? 0,
    finesse_bonus: r.finesse_bonus ?? 0,
    pole_bonus: r.pole_bonus ?? 0,
    aggression_bonus: r.aggression_bonus ?? 0,
    lap_led_bonus: r.lap_led_bonus ?? 0,
    fewest_incidents_bonus: r.fewest_incidents_bonus ?? 0,
    fastest_lap_bonus: r.fastest_lap_bonus ?? 0,
    sprint_sweep_bonus: r.sprint_sweep_bonus ?? 0,
    points_deduction: r.points_deduction ?? 0,
    classified: r.classified ?? true,
    dsq: r.dsq ?? false,
    finish_position: r.finish_position,
    adjusted_position: r.adjusted_position ?? null,
    interval_ten_thousandths: r.interval_ten_thousandths ?? null,
    laps_complete: r.laps_complete ?? null,
    average_lap_ten_thousandths: r.average_lap_ten_thousandths ?? null,
  };
  // Every points column, deduction included (the sum the results page showed before the switch).
  const total_points =
    filled.finish_points +
    filled.class_points +
    filled.finesse_bonus +
    filled.pole_bonus +
    filled.aggression_bonus +
    filled.lap_led_bonus +
    filled.fewest_incidents_bonus +
    filled.fastest_lap_bonus +
    filled.sprint_sweep_bonus +
    filled.points_deduction;
  return { ...filled, total_points };
}

function driverFor(id: string): DriverBasic {
  return {
    id,
    name: id,
    car_number: null,
    photo_url: null,
    iracing_cust_id: null,
    is_rookie: false,
    nationality_1: null,
    nationality_2: null,
    is_ai: false,
  };
}

function toRaceResultRow(r: FilledRow, position: number | null): RaceResultRow {
  const overall =
    r.average_lap_ten_thousandths !== null && r.laps_complete !== null
      ? r.laps_complete * r.average_lap_ten_thousandths
      : null;
  return {
    raceNumber: r.race_number,
    classId: r.class_id,
    position,
    dsq: r.dsq,
    driver: driverFor(r.driver_id),
    finishPosition: r.finish_position,
    startingPosition: null,
    wasAdjusted: r.adjusted_position !== null && r.adjusted_position !== r.finish_position,
    totalPoints: r.total_points,
    originalTotalPoints: r.total_points,
    bonusPoints: r.total_points - r.finish_points,
    classPoints: r.class_points,
    finesseBonus: r.finesse_bonus,
    poleBonus: r.pole_bonus,
    aggressionBonus: r.aggression_bonus,
    lapLedBonus: r.lap_led_bonus,
    fewestIncidentsBonus: r.fewest_incidents_bonus,
    fastestLapBonus: r.fastest_lap_bonus,
    sprintSweepBonus: r.sprint_sweep_bonus,
    pointsDeduction: r.points_deduction,
    polePosition: r.pole_bonus > 0,
    incidentsBonus: r.finesse_bonus > 0,
    aggressionBonusWon: r.aggression_bonus > 0,
    lapLedWon: r.lap_led_bonus > 0,
    fewestIncidentsWon: r.fewest_incidents_bonus > 0,
    fastestLapWon: r.fastest_lap_bonus > 0,
    sprintSweepWon: r.sprint_sweep_bonus > 0,
    incidents: null,
    laps: r.laps_complete,
    lapsLed: null,
    tags: r.classified ? [] : ['Unclassified'],
    margin: '',
    intervalTenThousandths: r.interval_ten_thousandths,
    penaltyOldPosition: null,
    hasPenalty: false,
    team: null,
    car: null,
    averageLapFormatted: '',
    averageLapTenThousandths: r.average_lap_ten_thousandths,
    bestLapFormatted: '',
    bestLapTenThousandths: null,
    overallRaceTimeFormatted: '',
    overallRaceTimeTenThousandths: overall,
    notInRoster: false,
  };
}

const rawPosition = (r: FilledRow) => r.adjusted_position ?? r.finish_position;

/**
 * Builds a RoundResults the way getRoundResults does: the overall view ranks by scored_position, and
 * each class view re-ranks its own non-DSQ rows by (adjusted or finish) position, DSQ rows last.
 */
export function toRoundResults(rows: ResultDbRow[]): RoundResults {
  const filled = rows.map(fill);
  const overall = new Map<number, RaceResultRow[]>();
  const byClass = new Map<number, Map<number, RaceResultRow[]>>();
  for (const raceNumber of [...new Set(filled.map((r) => r.race_number))]) {
    const race = filled.filter((r) => r.race_number === raceNumber);
    const sortedOverall = [...race].sort(
      (a, b) => (a.scored_position ?? Infinity) - (b.scored_position ?? Infinity),
    );
    overall.set(
      raceNumber,
      sortedOverall.map((r) => toRaceResultRow(r, r.scored_position)),
    );
    for (const classId of [...new Set(race.map((r) => r.class_id))]) {
      const inClass = race.filter((r) => r.class_id === classId);
      const ranked = inClass.filter((r) => !r.dsq).sort((a, b) => rawPosition(a) - rawPosition(b));
      const dsqd = inClass.filter((r) => r.dsq).sort((a, b) => rawPosition(a) - rawPosition(b));
      if (!byClass.has(classId)) byClass.set(classId, new Map());
      byClass
        .get(classId)!
        .set(raceNumber, [
          ...ranked.map((r, i) => toRaceResultRow(r, i + 1)),
          ...dsqd.map((r) => toRaceResultRow(r, null)),
        ]);
    }
  }
  return { byClass, overall, penalties: [] };
}
