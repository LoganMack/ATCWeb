/**
 * The driver profile's Splits table, Team grouping (driver-profile-polish FR5): each team row carries its
 * logo, like the Car rows, and "Independent" carries none.
 */
import { describe, expect, it } from 'vitest';
import { buildDriverPageGroups } from '../../src/lib/driverPage/groups';
import type { DriverRaceHistoryRow } from '../../src/lib/results/raceHistory';

function race(overrides: Partial<DriverRaceHistoryRow>): DriverRaceHistoryRow {
  return {
    subsessionId: 1,
    raceNumber: 1,
    season: null,
    trackName: 'Track',
    layoutLabel: 'Track',
    startTime: '2026-01-01T00:00:00Z',
    displayRoundNumber: 1,
    classId: 1,
    className: 'Alpha',
    car: null,
    team: null,
    startingPosition: 1,
    finishPosition: 1,
    classPosition: 1,
    classStartingPosition: 1,
    wasAdjusted: false,
    gainedPositions: false,
    margin: '',
    intervalTenThousandths: null,
    incidents: 0,
    laps: 10,
    lapsLed: 0,
    totalCorners: null,
    qualPosition: null,
    classQualPosition: null,
    totalPoints: 0,
    dsq: false,
    classified: true,
    bestLapTenThousandths: null,
    roundLayoutText: null,
    ...overrides,
  } as DriverRaceHistoryRow;
}

const teamRows = (history: DriverRaceHistoryRow[]) => {
  const { splitGroupsOverall, splitGroupsClass } = buildDriverPageGroups(history, []);
  return [
    splitGroupsOverall.find((g) => g.name === 'Team')!.rows,
    splitGroupsClass.find((g) => g.name === 'Team')!.rows,
  ];
};

describe('Splits, Team grouping (FR5)', () => {
  it('gives each team row its logo, in both the overall and class splits', () => {
    const history = [
      race({ subsessionId: 1, team: { name: 'Apex', logoUrl: 'https://img.test/apex.png' } }),
      race({ subsessionId: 2, team: { name: 'Bolt', logoUrl: 'https://img.test/bolt.png' } }),
    ];
    for (const rows of teamRows(history)) {
      expect(rows.map((r) => [r.label, r.logoUrl])).toEqual([
        ['Apex', 'https://img.test/apex.png'],
        ['Bolt', 'https://img.test/bolt.png'],
      ]);
    }
  });

  it('takes the logo from a race that has one when another of the team’s races has none', () => {
    const history = [
      race({ subsessionId: 1, team: { name: 'Apex', logoUrl: null } }),
      race({ subsessionId: 2, team: { name: 'Apex', logoUrl: 'https://img.test/apex.png' } }),
    ];
    expect(teamRows(history)[0][0]).toMatchObject({ label: 'Apex', logoUrl: 'https://img.test/apex.png' });
  });

  it('shows no logo for Independent or a team without one, and nothing for no races', () => {
    const history = [race({ team: null }), race({ subsessionId: 3, team: { name: 'Plain', logoUrl: null } })];
    expect(teamRows(history)[0].map((r) => [r.label, r.logoUrl])).toEqual([
      ['Independent', null],
      ['Plain', null],
    ]);
    expect(teamRows([])[0]).toEqual([]);
  });
});
