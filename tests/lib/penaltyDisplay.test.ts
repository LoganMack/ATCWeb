/**
 * Margins, intervals, overall race times and penalty flags on the results page (applyPenaltyDisplay).
 * Positions and points come from race_score_results_public, so they are not checked here. The
 * expected lines were recorded from the TypeScript engine before it was deleted, when the two
 * matched on every case: tests/fixtures/penalty-display/cases.json for small rounds, and
 * tests/fixtures/golden/atc17/penalty-display.json for every ATC17 round with penalties.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPenaltyDisplay,
  type RaceResultRow,
  type RoundResults,
} from '../../src/lib/results/roundResults';
import type { Penalty } from '../../src/lib/db/penalties';
import { toPenalties, toRoundResults, type PenaltyDbRow, type ResultDbRow } from './penaltyFixtures';
import { inputs } from '../golden/atc17';
import displayCases from '../fixtures/penalty-display/cases.json';
import atc17Display from '../fixtures/golden/atc17/penalty-display.json';

const FIELDS = [
  'margin',
  'intervalTenThousandths',
  'overallRaceTimeFormatted',
  'overallRaceTimeTenThousandths',
  'hasPenalty',
] as const;

/** One sorted line per row and view: "<view> r<race> <driver>: margin | interval | time | time | penalised". */
function display(results: RoundResults): string[] {
  const line = (view: string, race: number, r: RaceResultRow) =>
    `${view} r${race} ${r.driver.id}: ${FIELDS.map((f) => String(r[f])).join(' | ')}`;
  const out: string[] = [];
  for (const [race, rows] of results.overall) for (const r of rows) out.push(line('overall', race, r));
  for (const [classId, byRace] of results.byClass)
    for (const [race, rows] of byRace) for (const r of rows) out.push(line(`class ${classId}`, race, r));
  return out.sort();
}

function shown(rows: ResultDbRow[], penaltyRows: PenaltyDbRow[]): string[] {
  // The display reads only the scoring fields every Penalty has.
  const penalties = toPenalties(penaltyRows) as unknown as Penalty[];
  return display(applyPenaltyDisplay({ ...toRoundResults(rows), penalties }));
}

type DisplayCase = {
  name: string;
  description: string;
  rows: ResultDbRow[];
  penalties: PenaltyDbRow[];
  expected: string[];
};

describe('applyPenaltyDisplay on small rounds', () => {
  const cases = (displayCases as { cases: DisplayCase[] }).cases;

  it('has the recorded cases', () => {
    expect(cases.map((c) => c.name)).toEqual([
      'b-time-penalty-reorders-and-reprices',
      'c-points-deduction-only',
      'd-dsq-with-points-penalty',
      'e-qualifying-penalty-lands-on-race-1',
      'f-multiclass-class-view',
    ]);
  });

  it.each(cases.map((c) => [`${c.name}: ${c.description}`, c] as const))('%s', (_, c) => {
    expect(shown(c.rows, c.penalties)).toEqual(c.expected);
  });

  it('adds a time penalty to the penalised driver only', () => {
    const b = cases.find((c) => c.name === 'b-time-penalty-reorders-and-reprices')!;
    const lines = shown(b.rows, b.penalties).filter((l) => l.startsWith('overall r1 '));
    // B finished 20 laps at 100.1000 s (2002.0000 s); the 5 s penalty makes it 2007.0000 s.
    expect(lines.find((l) => l.startsWith('overall r1 B:'))).toContain('| 20070000 | true');
    expect(lines.find((l) => l.startsWith('overall r1 C:'))).toContain('| false');
  });

  it('changes nothing for a round with no penalties', () => {
    const b = cases.find((c) => c.name === 'b-time-penalty-reorders-and-reprices')!;
    const results = toRoundResults(b.rows);
    expect(display(applyPenaltyDisplay({ ...results, penalties: [] }))).toEqual(display(results));
  });
});

describe('applyPenaltyDisplay on ATC17', () => {
  const recorded = (atc17Display as { rounds: Record<string, string[]> }).rounds;

  // The same row shape the results page reads, rebuilt from the golden capture.
  const driverByCust = new Map(inputs.drivers.map((d) => [d.iracing_cust_id, d.id]));
  const key = (sid: number, race: number, driver: string | undefined) => `${sid}:${race}:${driver}`;
  const raw = new Map(
    inputs.rawResults.map((r) => [key(r.subsession_id, r.race_number, driverByCust.get(r.cust_id)), r]),
  );
  const laps = new Map(
    inputs.lapStats.map((r) => [key(r.subsession_id, r.race_number, driverByCust.get(r.cust_id)), r]),
  );
  const classScores = new Map(
    Object.values(inputs.scoresByClass)
      .flat()
      .map((r) => [key(r.subsession_id, r.race_number, r.driver_id), r]),
  );
  const rowsBySubsession = new Map<number, ResultDbRow[]>();
  for (const s of inputs.overallScores) {
    const k = key(s.subsession_id, s.race_number, s.driver_id);
    const r = raw.get(k);
    const c = classScores.get(k);
    const row: ResultDbRow = {
      subsession_id: s.subsession_id,
      race_number: s.race_number,
      driver_id: s.driver_id,
      class_id: s.class_id,
      scored_position: s.dsq ? null : s.scored_position,
      finish_points: s.finish_points,
      class_points: c?.class_points ?? 0,
      finesse_bonus: s.finesse_bonus,
      pole_bonus: s.pole_bonus,
      aggression_bonus: s.aggression_bonus,
      points_deduction: s.points_deduction,
      classified: s.classified,
      dsq: s.dsq,
      finish_position: r?.finish_position ?? s.scored_position ?? 999,
      adjusted_position: r?.adjusted_position ?? null,
      interval_ten_thousandths: r?.interval_ten_thousandths ?? null,
      laps_complete: r?.laps_complete ?? null,
      average_lap_ten_thousandths: laps.get(k)?.average_lap_ten_thousandths ?? null,
    };
    if (!rowsBySubsession.has(s.subsession_id)) rowsBySubsession.set(s.subsession_id, []);
    rowsBySubsession.get(s.subsession_id)!.push(row);
  }
  const penaltyRows = inputs.penalties as unknown as PenaltyDbRow[];

  it('covers every round with penalties', () => {
    const withPenalties = [...rowsBySubsession.keys()]
      .filter((sid) => penaltyRows.some((p) => p.subsession_id === sid))
      .map(String)
      .sort();
    expect(withPenalties).toEqual(Object.keys(recorded).sort());
    expect(withPenalties.length).toBeGreaterThan(5);
  });

  it.each(Object.keys(recorded).map((sid) => [sid] as const))(
    'round %s matches the recorded display',
    (sid) => {
      const rows = rowsBySubsession.get(Number(sid)) ?? [];
      const penalties = penaltyRows.filter((p) => p.subsession_id === Number(sid));
      expect(shown(rows, penalties)).toEqual(recorded[sid]);
    },
  );
});
