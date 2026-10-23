import { describe, expect, it } from 'vitest';
import {
  concealmentViolations,
  diffRecords,
  findTopTwoTies,
  groupDifferences,
  markTieOrder,
  renderReport,
} from '../../scripts/compareRoundStatsLib.mjs';

// The parity comparison's pure helpers (BR4.1): what today's TypeScript computes against what the
// round stats tables store.
const FIELDS = ['points', 'wins', 'laps'];

type ParityRecord = Record<string, unknown> & {
  kind: string;
  season: string;
  round: number | string;
  subject: string;
};

const today: ParityRecord[] = [
  { kind: 'overall', season: 'ATC17', round: 101, subject: 'driver-a', points: 181, wins: 1, laps: 40 },
  { kind: 'overall', season: 'ATC17', round: 101, subject: 'driver-b', points: 124, wins: 0, laps: 40 },
  { kind: 'cars', season: 'ATC17', round: 'season', subject: 'driver-a', cars: { 'Car X': 2, 'Car Y': 1 } },
];

describe('diffRecords', () => {
  it('finds no difference in identical inputs, whatever the key order of a car map', () => {
    const stored = today.map((r) => ({ ...r }));
    stored[2] = { ...stored[2], cars: { 'Car Y': 1, 'Car X': 2 } };
    expect(diffRecords(today.slice(0, 2), stored.slice(0, 2), FIELDS)).toEqual([]);
    expect(diffRecords(today.slice(2), stored.slice(2), ['cars'])).toEqual([]);
    expect(groupDifferences([]).blocking).toBe(0);
  });

  it('reports one changed field with its driver, round and field, and a missing stored row', () => {
    const stored = [{ ...today[0], laps: 39 }];
    const differences = diffRecords(today.slice(0, 2), stored, FIELDS);
    expect(differences).toEqual([
      {
        kind: 'overall',
        season: 'ATC17',
        round: 101,
        subject: 'driver-a',
        field: 'laps',
        expected: 40,
        actual: 39,
        cause: 'value',
      },
      {
        kind: 'overall',
        season: 'ATC17',
        round: 101,
        subject: 'driver-b',
        field: '(row)',
        expected: 'present',
        actual: 'missing',
        cause: 'missing-stored',
      },
    ]);
    const { counts, blocking } = groupDifferences(differences);
    expect(counts).toMatchObject({ value: 1, 'missing-stored': 1 });
    expect(blocking).toBe(2);
    const report = renderReport({
      generatedAt: '2026-10-22T00:00:00.000Z',
      source: 'https://example.invalid',
      seasons: ['ATC17'],
      recordCounts: { overall: 2 },
      differences,
    });
    expect(report).toContain('FAIL, 2 blocking differences');
    expect(report).toContain('| ATC17 | 101 | driver-a | 40 | 39 |');
  });

  it('lists a top-2 tie apart from the blocking differences', () => {
    // Team T's race: driver-a 20, driver-b 5, driver-c 5. b and c tie for the second counted place.
    const scoreRows = [
      { subsession_id: 101, race_number: 1, team_id: 'T', driver_id: 'driver-a', overall_total: 20 },
      { subsession_id: 101, race_number: 1, team_id: 'T', driver_id: 'driver-b', overall_total: 5 },
      { subsession_id: 101, race_number: 1, team_id: 'T', driver_id: 'driver-c', overall_total: 5 },
      { subsession_id: 101, race_number: 1, team_id: 'U', driver_id: 'driver-d', overall_total: 5 },
    ];
    const ties = findTopTwoTies(scoreRows, 'ATC17', (r: { overall_total: number }) => r.overall_total);
    expect([...ties].sort()).toEqual(['ATC17|driver-b|T', 'ATC17|driver-c|T']);

    const usage = (subject: string, scored: number) => ({
      kind: 'team-usage',
      season: 'ATC17',
      round: 'season',
      subject,
      racesUnderTeam: 1,
      racesScoredForTeam: scored,
    });
    const differences = diffRecords(
      [usage('driver-b|T', 1), usage('driver-c|T', 0), usage('driver-d|U', 1)],
      [usage('driver-b|T', 0), usage('driver-c|T', 1), usage('driver-d|U', 0)],
      ['racesUnderTeam', 'racesScoredForTeam'],
    );
    const marked = markTieOrder(differences, ties, ['racesScoredForTeam']);
    expect(marked.map((d: { subject: string; cause: string }) => `${d.subject}:${d.cause}`)).toEqual([
      'driver-b|T:tie-order',
      'driver-c|T:tie-order',
      'driver-d|U:value',
    ]);
    const { counts, blocking } = groupDifferences(marked);
    expect(counts).toMatchObject({ 'tie-order': 2, value: 1 });
    expect(blocking).toBe(1);
  });
});

describe('concealmentViolations', () => {
  it('blocks on final values or penalty points stored for an unposted round, and passes posted ones', () => {
    const posted = new Set([101]);
    const drivers = [
      { subsession_id: 101, driver_id: 'driver-a', final_visible: true },
      { subsession_id: 102, driver_id: 'driver-a', final_visible: false },
      { subsession_id: 102, driver_id: 'driver-b', final_visible: true },
    ];
    const penalties = [
      { subsession_id: 101, driver_id: 'driver-a', penalty_points: 2 },
      { subsession_id: 102, driver_id: 'driver-c', penalty_points: 3 },
    ];
    const violations = concealmentViolations('ATC17', drivers, penalties, posted);
    expect(
      violations.map(
        (d: { round: number; subject: string; field: string }) => `${d.round}:${d.subject}:${d.field}`,
      ),
    ).toEqual(['102:driver-b:final_visible', '102:driver-c:penalty_points']);
    const { counts, blocking } = groupDifferences(violations);
    expect(counts).toMatchObject({ concealment: 2 });
    expect(blocking).toBe(2);
    expect(concealmentViolations('ATC17', drivers.slice(0, 2), penalties.slice(0, 1), posted)).toEqual([]);
  });
});
