import { describe, expect, it } from 'vitest';
import {
  ADMIN_VIEW,
  SWITCHES,
  STALE_STORED_SCORE,
  attributeRow,
  groupByCause,
  pairKey,
  pairsNeeded,
  renderDecisions,
  renderReport,
  type AudienceInput,
  type DiffLine,
  type FieldValues,
  type RowInput,
  type SwitchName,
} from '../../scripts/lib/scoringAttribution';

// A row that Legacy-mode reproduces exactly (today == legacy), so each test only states what a
// switch, the stored score or the audience changes.
const BASE: FieldValues = {
  row: 1,
  position: 5,
  class_position: 2,
  finish_points: 30,
  class_points: 0,
  aggression_bonus: 0,
  deduction: 0,
  overall_total: 30,
  class_total: 30,
};

function audience(opts: {
  today?: FieldValues;
  next?: FieldValues;
  singles?: Partial<Record<SwitchName, FieldValues>>;
  pairs?: Record<string, FieldValues>;
}): AudienceInput {
  const singles: Partial<Record<SwitchName, FieldValues>> = {};
  for (const s of SWITCHES) singles[s] = { ...BASE, ...(opts.singles?.[s] ?? {}) };
  return {
    today: { ...BASE, ...(opts.today ?? {}) },
    new: { ...BASE, ...(opts.next ?? {}) },
    legacy: { ...BASE },
    singles,
    pairs: opts.pairs,
  };
}

function row(audiences: RowInput['audiences'], extra: Partial<RowInput> = {}): RowInput {
  return {
    subsessionId: 1001,
    raceNumber: 1,
    driverId: 'driver-a',
    driverName: 'Driver A',
    audiences,
    storedRaw: { row: 1, position: 5, finish_points: 30 },
    legacyRaw: { row: 1, position: 5, finish_points: 30 },
    ...extra,
  };
}

function bothAudiences(a: AudienceInput): RowInput['audiences'] {
  return { 'non-admin': a, admin: a };
}

describe('scoring attribution (BR6.2)', () => {
  it('attributes a difference to the one switch whose preview moves that field', () => {
    const a = audience({
      next: { deduction: 5, overall_total: 25 },
      singles: { 'deduction-sign': { deduction: 5, overall_total: 25 } },
    });
    const lines = attributeRow(row({ 'non-admin': a }));

    expect(lines.map((l) => [l.field, l.today, l.new, l.causes])).toEqual([
      ['deduction', 0, 5, ['deduction-sign']],
      ['overall_total', 30, 25, ['deduction-sign']],
    ]);
    expect(lines.every((l) => l.audience === 'non-admin' && l.legacyMatchesToday)).toBe(true);
  });

  it('attributes an unclassified row renumbered by the re-order to unclassified-position', () => {
    // Today the results page keeps an unclassified row at its raw position; the new final set
    // renumbers it with everyone else.
    const a = audience({
      next: { position: 4 },
      singles: { 'unclassified-position': { position: 4 } },
    });
    const [line] = attributeRow(row(bothAudiences(a)));

    expect([line.field, line.today, line.new, line.causes]).toEqual(['position', 5, 4, ['unclassified-position']]);
    expect(line.legacyMatchesToday).toBe(true);
  });

  it('lists every single switch that moves the field when two independent causes hit one line', () => {
    const a = audience({
      next: { overall_total: 22 },
      singles: {
        'deduction-sign': { overall_total: 25 },
        'overall-formula': { overall_total: 27 },
        // Moves another field only: must not be listed on the overall_total line.
        'bonus-after-reorder': { aggression_bonus: 3 },
      },
    });
    const [line] = attributeRow(row({ 'non-admin': a }));

    expect(line.field).toBe('overall_total');
    expect(line.causes).toEqual(['deduction-sign', 'overall-formula']);
    expect(pairsNeeded(row({ 'non-admin': a }))).toEqual([]);
  });

  it('falls back to a combined pair only when no single switch explains the line', () => {
    // Each switch alone touches the row but leaves finish_points as in Legacy-mode; only together
    // do they move it (a re-ordered position priced with the bonus rule).
    const key = pairKey('reorder-tie-break', 'bonus-after-reorder');
    const singles = {
      'bonus-after-reorder': { aggression_bonus: 2 },
      'reorder-tie-break': { position: 4 },
    };
    const withoutPairs = row({ 'non-admin': audience({ next: { finish_points: 32 }, singles }) });

    expect(key).toBe('bonus-after-reorder+reorder-tie-break');
    expect(pairsNeeded(withoutPairs)).toEqual([key]);

    const withPairs = row({
      'non-admin': audience({ next: { finish_points: 32 }, singles, pairs: { [key]: { ...BASE, finish_points: 32 } } }),
    });
    const [line] = attributeRow(withPairs);
    expect(line.causes).toEqual([key]);
  });

  it('leaves a line unexplained when no switch, pair, stored score or audience accounts for it', () => {
    const r = row({ 'non-admin': audience({ next: { class_points: 4 } }) });
    const lines = attributeRow(r);

    expect(lines).toHaveLength(1);
    expect(lines[0].field).toBe('class_points');
    expect(lines[0].causes).toEqual([]);
    expect(pairsNeeded(r)).toEqual([]);
    expect(groupByCause(lines).map((g) => g.cause)).toEqual(['unexplained']);
  });

  it('adds stale-stored-score when race_scores differs from Legacy-mode raw in that field', () => {
    const a = audience({ today: { finish_points: 26 }, next: { finish_points: 30 } });
    const lines = attributeRow(
      row(
        { 'non-admin': a },
        {
          storedRaw: { row: 1, position: 5, finish_points: 26 },
          legacyRaw: { row: 1, position: 5, finish_points: 30 },
        },
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].causes).toEqual([STALE_STORED_SCORE]);
    // Today (26) is not what Legacy-mode (30) gives, which the report flags separately.
    expect(lines[0].legacyMatchesToday).toBe(false);

    // A field the stored row does not carry is never marked stale.
    const other = attributeRow(
      row({ 'non-admin': audience({ next: { class_position: 3 } }) }, {
        storedRaw: { row: 1, finish_points: 26 },
        legacyRaw: { row: 1, finish_points: 30 },
      }),
    );
    expect(other[0].causes).toEqual([]);
  });

  it('adds admin-view to a difference only the admin audience sees', () => {
    // Unposted round: non-admins see the raw set (no change), admins the penalised final set.
    const nonAdmin = audience({});
    const admin = audience({
      next: { position: 7, finish_points: 24 },
      singles: { 'reorder-tie-break': { position: 7 } },
    });
    const lines = attributeRow(row({ 'non-admin': nonAdmin, admin }));

    expect(lines.map((l) => [l.audience, l.field, l.causes])).toEqual([
      ['admin', 'position', ['reorder-tie-break', ADMIN_VIEW]],
      ['admin', 'finish_points', [ADMIN_VIEW]],
    ]);

    // The same difference for both audiences is not admin-view.
    const shared = audience({ next: { position: 7 }, singles: { 'reorder-tie-break': { position: 7 } } });
    const both = attributeRow(row(bothAudiences(shared)));
    expect(both.map((l) => l.causes)).toEqual([['reorder-tie-break'], ['reorder-tie-break']]);
  });

  it('produces no line when today and new agree, whatever the previews do', () => {
    const a = audience({
      singles: { 'deduction-sign': { deduction: 9 }, 'overall-formula': { overall_total: 99 } },
    });
    const r = row(bothAudiences(a), {
      storedRaw: { row: 1, finish_points: 1 },
      legacyRaw: { row: 1, finish_points: 30 },
    });

    expect(attributeRow(r)).toEqual([]);
    expect(pairsNeeded(r)).toEqual([]);
    expect(renderDecisions([], 'T').causes).toEqual([]);
  });

  it('groups the report by cause with counts first, listing a multi-cause line under each cause', () => {
    const line = (over: Partial<DiffLine>): DiffLine => ({
      subsessionId: 1001,
      raceNumber: 1,
      driverId: 'driver-a',
      driverName: 'Driver A',
      audience: 'non-admin',
      field: 'overall_total',
      today: 30,
      new: 25,
      causes: [],
      legacyMatchesToday: true,
      ...over,
    });
    const lines: DiffLine[] = [
      line({ causes: ['deduction-sign', 'overall-formula'] }),
      line({ subsessionId: 1002, field: 'deduction', today: 0, new: 5, causes: ['deduction-sign'] }),
      line({ subsessionId: 1003, field: 'class_points', today: 4, new: 2, causes: [] }),
      line({ subsessionId: 1003, audience: 'admin', field: 'position', today: 3, new: 4, causes: [ADMIN_VIEW] }),
    ];

    const groups = groupByCause(lines);
    expect(groups.map((g) => [g.cause, g.lines.length, g.rounds])).toEqual([
      ['deduction-sign', 2, [1001, 1002]],
      ['overall-formula', 1, [1001]],
      [ADMIN_VIEW, 1, [1003]],
      ['unexplained', 1, [1003]],
    ]);

    const report = renderReport(lines, { generatedAt: 'T', roundsCompared: 3, roundsWithDifferences: 3 });
    const countsAt = report.indexOf('## Counts by cause');
    const firstSection = report.indexOf('## deduction-sign (2 lines, 2 rounds)');
    expect(countsAt).toBeGreaterThan(-1);
    expect(firstSection).toBeGreaterThan(countsAt);
    expect(report).toContain('| deduction-sign | 2 | 2 |');
    expect(report).toContain('| unexplained | 1 | 1 |');
    expect(report).toContain('- Unexplained lines: 1');
    // The two-cause line appears in both sections, each time with both causes.
    const twoCause = '| 1001 | 1 | Driver A (driver-a) | non-admin | overall_total | 30 | 25 | deduction-sign, overall-formula |';
    expect(report.split(twoCause).length - 1).toBe(2);

    const decisions = renderDecisions(lines, 'T');
    expect(decisions.causes.map((c) => [c.cause, c.decision, c.lines])).toEqual([
      ['deduction-sign', 'undecided', 2],
      ['overall-formula', 'undecided', 1],
      [ADMIN_VIEW, 'undecided', 1],
      ['unexplained', 'undecided', 1],
    ]);
  });
});
