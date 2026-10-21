/**
 * Loads penalty-engine cases from tests/fixtures/penalties/<function>/<case>.json and maps their rows,
 * written in database column names, onto the TypeScript shapes src/lib/penalties.ts takes. Keeping the
 * fixtures in column names lets the scoring move (U6) insert the same rows into a scratch database and
 * check its SQL against the same hand-derived expected values.
 *
 * A result row is one driver's race: race_scores columns plus the curated_race_results columns the
 * engine reads (joined on driver). Omitted columns take the table defaults, and total_points is
 * computed the way the generated column computes it.
 */
import type { LeaderRaceStats } from '../../src/lib/penalties/reorder';
import type { PenaltyLike } from '../../src/lib/penalties/effective';
import type { SeasonClassScoreRow, SeasonScoreRow } from '../../src/lib/penalties/seasonAdjustments';
import type { DriverBasic, RaceResultRow, RoundResults } from '../../src/lib/results';

// Bundled by Vite's glob import, so the tests need no Node file-system access.
const FIXTURES = import.meta.glob('../fixtures/penalties/*/*.json', { eager: true, import: 'default' });

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
  const prefix = `../fixtures/penalties/${fn}/`;
  const paths = Object.keys(FIXTURES)
    .filter((p) => p.startsWith(prefix))
    .sort();
  if (paths.length === 0) throw new Error(`No penalty fixtures in tests/fixtures/penalties/${fn}/`);
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

/** One driver's race: race_scores columns plus the curated_race_results columns the engine reads. */
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
  // Same sum as race_scores.total_points (a generated column).
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
  return { byClass, overall };
}

/** The rows computeSeasonOverallAdjustments takes, built as buildSeasonOverallContext builds them. */
export function toSeasonScoreRows(rows: ResultDbRow[]): SeasonScoreRow[] {
  return rows.map(fill).map((r) => ({
    subsessionId: r.subsession_id,
    raceNumber: r.race_number,
    driverId: r.driver_id,
    dsq: r.dsq,
    classified: r.classified,
    scoredPosition: r.scored_position,
    intervalTenThousandths: r.interval_ten_thousandths,
    finishPoints: r.finish_points,
    finesseBonus: r.finesse_bonus,
    poleBonus: r.pole_bonus,
    aggressionBonus: r.aggression_bonus,
    pointsDeduction: r.points_deduction,
    lapsComplete: r.laps_complete,
    averageLapTenThousandths: r.average_lap_ten_thousandths,
  }));
}

/** One class's rows for computeSeasonClassAdjustments: DSQ rows dropped, class position re-derived per race. */
export function toSeasonClassScoreRows(rows: ResultDbRow[], classId: number): SeasonClassScoreRow[] {
  const filled = rows.map(fill).filter((r) => r.class_id === classId && !r.dsq);
  const out: SeasonClassScoreRow[] = [];
  const raceKeys = [...new Set(filled.map((r) => `${r.subsession_id}:${r.race_number}`))];
  for (const key of raceKeys) {
    const race = filled
      .filter((r) => `${r.subsession_id}:${r.race_number}` === key)
      .sort((a, b) => rawPosition(a) - rawPosition(b));
    race.forEach((r, i) =>
      out.push({
        subsessionId: r.subsession_id,
        raceNumber: r.race_number,
        driverId: r.driver_id,
        dsq: r.dsq,
        classified: r.classified,
        classPosition: i + 1,
        intervalTenThousandths: r.interval_ten_thousandths,
        totalPoints: r.total_points,
        classPoints: r.class_points,
        finesseBonus: r.finesse_bonus,
        poleBonus: r.pole_bonus,
        aggressionBonus: r.aggression_bonus,
        lapLedBonus: r.lap_led_bonus,
        fewestIncidentsBonus: r.fewest_incidents_bonus,
        fastestLapBonus: r.fastest_lap_bonus,
        sprintSweepBonus: r.sprint_sweep_bonus,
        pointsDeduction: r.points_deduction,
        lapsComplete: r.laps_complete,
        averageLapTenThousandths: r.average_lap_ten_thousandths,
      }),
    );
  }
  return out;
}

/** Each race's on-track winner (finish_position 1), keyed `${subsession_id}:${race_number}`. */
export function toLeaderStatsByRace(rows: ResultDbRow[]): Map<string, LeaderRaceStats> {
  const out = new Map<string, LeaderRaceStats>();
  for (const r of rows.map(fill)) {
    if (r.finish_position === 1) {
      out.set(`${r.subsession_id}:${r.race_number}`, {
        lapsComplete: r.laps_complete,
        averageLapTenThousandths: r.average_lap_ten_thousandths,
      });
    }
  }
  return out;
}

/** The same value for every subsession in the rows, as buildSeasonOverallContext repeats one season's value. */
export function bySubsession<T>(rows: ResultDbRow[], value: T): Map<number, T> {
  return new Map(rows.map(fill).map((r) => [r.subsession_id, value]));
}
