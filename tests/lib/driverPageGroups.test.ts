/**
 * The driver profile's Splits table, Team grouping (driver-profile-polish FR5): each team row carries its
 * logo, like the Car rows, and "Independent" carries none. The Bests tab's per-filter records (W5).
 */
import { describe, expect, it } from 'vitest';
import { buildDriverPageGroups } from '../../src/lib/driverPage/groups';
import type { DriverRaceHistoryRow } from '../../src/lib/results/raceHistory';
import type { RoundBestLap } from '../../src/lib/db/roundBestLaps';
import { buildLeagueRecords } from '../../src/lib/results/trackRecords';

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

describe('Bests per filter (W5; BR2.1-BR2.4)', () => {
  const leagueLap = (overrides: Partial<RoundBestLap>): RoundBestLap => ({
    subsession_id: 50,
    class_id: 2,
    best_lap_ten_thousandths: 1_000_000,
    race_number: 1,
    finish_position: 1,
    cust_id: 7,
    roster_driver_id: 'other',
    display_name: 'Other Driver',
    car_name: 'Car',
    track_name: 'Monza',
    layout: 'Grand Prix',
    start_time: '2026-03-01T23:00:00+00:00',
    ...overrides,
  });
  const league = buildLeagueRecords(
    [
      leagueLap({ class_id: 2, best_lap_ten_thousandths: 1_000_000 }),
      leagueLap({
        subsession_id: 51,
        class_id: 3,
        best_lap_ten_thousandths: 1_050_000,
        roster_driver_id: 'me',
      }),
    ],
    () => 'layout:l-gp',
  );
  const inputs = {
    league,
    gammaClassId: 2,
    deltaClassId: 3,
    driverNameById: new Map([
      ['other', 'Other Driver'],
      ['me', 'Me'],
    ]),
  };
  const monza = {
    layoutLabel: 'Monza — GP',
    trackName: 'Monza',
    recordKey: 'layout:l-gp',
    layoutRecordSeconds: 101.0,
    layoutRecordHolder: 'Typed',
    layoutRecordDate: '2020-01-01',
  };
  // Raced Delta here once and Gamma once: the PB is the faster lap in any class.
  const history = [
    race({ ...monza, subsessionId: 51, classId: 3, bestLapTenThousandths: 1_050_000 }),
    race({ ...monza, subsessionId: 52, classId: 2, bestLapTenThousandths: 1_020_000 }),
  ];

  it('takes the personal best in any class and shows each filter its own record', () => {
    const [row] = buildDriverPageGroups(history, [], inputs).layoutBests;
    expect(row.personalBestTenThousandths).toBe(1_020_000);
    expect(row.byFilter.overall).toMatchObject({
      recordSeconds: 100,
      holder: 'Other Driver',
      date: '2026-03-01',
    });
    expect(row.byFilter.gamma).toMatchObject({
      recordSeconds: 100,
      deltaText: '+0:02.000',
      deltaSortValue: 2000,
    });
    expect(row.byFilter.gamma.holdsRecord).toBe(false);
  });

  it('turns the PB blue with "---" when it equals or beats the shown record', () => {
    const [row] = buildDriverPageGroups(history, [], inputs).layoutBests;
    expect(row.byFilter.delta).toMatchObject({
      recordSeconds: 105,
      holdsRecord: true,
      deltaText: '---',
      deltaSortValue: null,
    });
  });

  it('shows "—" for a missing class, and the typed record without league data', () => {
    const [missing] = buildDriverPageGroups(history, [], { ...inputs, deltaClassId: null }).layoutBests;
    expect(missing.byFilter.delta).toMatchObject({
      recordFormatted: '—',
      deltaText: '—',
      holdsRecord: false,
    });
    const [typedOnly] = buildDriverPageGroups(history, []).layoutBests;
    expect(typedOnly.byFilter.overall).toMatchObject({
      recordSeconds: 101,
      holder: 'Typed',
      date: '2020-01-01',
    });
    expect(typedOnly.byFilter.overall.holdsRecord).toBe(false);
    expect(typedOnly.byFilter.gamma.recordFormatted).toBe('—');
  });
});

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
