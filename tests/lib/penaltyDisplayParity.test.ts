/**
 * Margins, intervals, overall race times and penalty flags on the results page must read exactly as
 * they did before the switch. Before it, applyPenaltiesToRoundResults produced them; now
 * applyPenaltyDisplay does, from the same inputs. Positions and points are not compared here: they
 * now come from race_score_results_public. The old engine stays until the contract step, so it is
 * the yardstick.
 */
import { describe, expect, it } from 'vitest';
import { applyPenaltiesToRoundResults } from '../../src/lib/penalties/roundResults';
import { applyPenaltyDisplay, type RaceResultRow, type RoundResults } from '../../src/lib/results/roundResults';
import {
  loadPenaltyCases,
  toPenalties,
  toRoundResults,
  type PenaltyDbRow,
  type ResultDbRow,
} from './penaltyFixtures';
import { inputs } from '../golden/atc17';
import type { Penalty } from '../../src/lib/db/penalties';

const FIELDS = [
  'margin',
  'intervalTenThousandths',
  'overallRaceTimeFormatted',
  'overallRaceTimeTenThousandths',
  'hasPenalty',
] as const;

function display(results: RoundResults): string[] {
  const line = (view: string, race: number, r: RaceResultRow) =>
    `${view} r${race} ${r.driver.id}: ${FIELDS.map((f) => String(r[f])).join(' | ')}`;
  const out: string[] = [];
  for (const [race, rows] of results.overall) for (const r of rows) out.push(line('overall', race, r));
  for (const [classId, byRace] of results.byClass)
    for (const [race, rows] of byRace) for (const r of rows) out.push(line(`class ${classId}`, race, r));
  return out.sort();
}

function compare(rows: ResultDbRow[], penaltyRows: PenaltyDbRow[], format: 'sprint' | 'endurance' | null) {
  const penalties = toPenalties(penaltyRows);
  const before = applyPenaltiesToRoundResults(toRoundResults(rows), penalties, format);
  // The display reads only the scoring fields every Penalty has.
  const after = applyPenaltyDisplay({ ...toRoundResults(rows), penalties: penalties as unknown as Penalty[] });
  return { before: display(before), after: display(after) };
}

describe('penalty display parity with the pre-switch results page', () => {
  type Input = { format: 'sprint' | 'endurance' | null; rows: ResultDbRow[]; penalties: PenaltyDbRow[] };
  it.each(loadPenaltyCases<Input>('applyPenaltiesToRoundResults').map((c) => [c.file, c] as const))(
    'fixture %s',
    (_, c) => {
      const { before, after } = compare(c.input.rows, c.input.penalties, c.input.format);
      expect(after).toEqual(before);
    },
  );

  it('matches on every ATC17 round with penalties', () => {
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
    const formatBySubsession = new Map(inputs.seasonRounds.map((r) => [r.subsession_id, r.format]));
    let rounds = 0;
    for (const [subsessionId, rows] of rowsBySubsession) {
      const penaltyRows = (inputs.penalties as unknown as PenaltyDbRow[]).filter(
        (p) => p.subsession_id === subsessionId,
      );
      if (penaltyRows.length === 0) continue;
      const { before, after } = compare(rows, penaltyRows, formatBySubsession.get(subsessionId) ?? null);
      expect(after, `round ${subsessionId}`).toEqual(before);
      rounds++;
    }
    expect(rounds).toBeGreaterThan(5);
  });
});
