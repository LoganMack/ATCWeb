/**
 * The driver profile's Splits table, Team grouping (driver-profile-polish FR5): each team row carries its
 * logo, like the Car rows, and "Independent" carries none. The Bests tab's per-filter records (W5).
 */
import { describe, expect, it } from 'vitest';
import { buildDriverPageGroups } from '../../src/lib/driverPage/groups';
import { TRACK_TYPE_LABELS, WEATHER_LABELS, type SplitGroup } from '../../src/lib/driverPage/helpers';
import { LAYOUT_CATEGORY_LABELS, LAYOUT_CATEGORY_ORDER } from '../../src/lib/circuitCategory';
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
    wetAffected: null,
    layoutCategory: null,
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

/** Weather and Track Type splits (driver-splits U7: BR1.1, BR1.4 to BR1.11; NFR7.1, NFR7.3). */
describe('Splits, Weather and Track Type', () => {
  const groupsOf = (history: DriverRaceHistoryRow[]) => buildDriverPageGroups(history, []);
  const rowsOf = (groups: SplitGroup[], name: string) => groups.find((g) => g.name === name)!.rows;
  const both = (history: DriverRaceHistoryRow[], name: string) => {
    const { splitGroupsOverall, splitGroupsClass } = groupsOf(history);
    return [rowsOf(splitGroupsOverall, name), rowsOf(splitGroupsClass, name)];
  };
  const summary = (rows: { label: string; starts: number }[]) => rows.map((r) => [r.label, r.starts]);

  // One round with race 2 wet, on three layouts of different categories, plus a race on an uncategorised one.
  const city = { subsessionId: 1, layoutCategory: 'street', layoutLabel: 'City' } as const;
  const history = [
    race({ ...city, raceNumber: 1, wetAffected: false }),
    race({ ...city, raceNumber: 2, wetAffected: true }),
    race({ ...city, raceNumber: 3, wetAffected: false }),
    race({ subsessionId: 2, wetAffected: false, layoutCategory: 'oval', layoutLabel: 'Bowl' }),
    race({ subsessionId: 3, wetAffected: false, layoutCategory: 'road_long', layoutLabel: 'Ring' }),
    race({ subsessionId: 4, wetAffected: true, layoutCategory: null, layoutLabel: 'Mystery' }),
  ];

  it('lists the seven categories in order in both sets, the first five unchanged (AC4.1.6; BR1.11)', () => {
    const withData = groupsOf(history);
    const without = groupsOf(history.map((r) => ({ ...r, wetAffected: null, layoutCategory: null })));
    const names = ['Month', 'Round', 'Car', 'Team', 'Layout', 'Weather', 'Track Type'];
    expect(withData.splitGroupsOverall.map((g) => g.name)).toEqual(names);
    expect(withData.splitGroupsClass.map((g) => g.name)).toEqual(names);
    expect(withData.splitGroupsOverall.slice(0, 5)).toEqual(without.splitGroupsOverall.slice(0, 5));
    expect(withData.splitGroupsClass.slice(0, 5)).toEqual(without.splitGroupsClass.slice(0, 5));
  });

  it('puts a wet race under Wet and the rest of its round under Dry (AC4.1.1, AC4.1.2)', () => {
    const roundOne = history.filter((r) => r.subsessionId === 1);
    for (const rows of both(roundOne, 'Weather')) {
      expect(summary(rows)).toEqual([
        ['Dry', 2],
        ['Wet', 1],
      ]);
    }
  });

  it('shows only the Dry row for a driver with no wet race (AC4.1.4; BR1.4)', () => {
    const dry = [race({ wetAffected: false }), race({ subsessionId: 2, wetAffected: false })];
    for (const rows of both(dry, 'Weather')) expect(summary(rows)).toEqual([['Dry', 2]]);
  });

  it('ranks the class set by class position (AC4.1.5)', () => {
    const wet = [race({ wetAffected: true, finishPosition: 5, classPosition: 1 })];
    const [overall, byClass] = both(wet, 'Weather');
    expect(overall[0]).toMatchObject({ label: 'Wet', wins: 0, avgFinish: '5.0' });
    expect(byClass[0]).toMatchObject({ label: 'Wet', wins: 1, avgFinish: '1.0' });
  });

  it('leaves Weather empty when the wet flags are unknown, keeping the other groups (BR1.5)', () => {
    const unknown = history.map((r) => ({ ...r, wetAffected: null }));
    const { splitGroupsOverall, splitGroupsClass } = groupsOf(unknown);
    for (const groups of [splitGroupsOverall, splitGroupsClass]) {
      expect(rowsOf(groups, 'Weather')).toEqual([]);
      expect(rowsOf(groups, 'Layout').length).toBeGreaterThan(0);
      expect(summary(rowsOf(groups, 'Track Type'))).toHaveLength(3);
    }
  });

  it('lists track types in the fixed category order (AC4.2.1, AC4.2.2; BR1.6)', () => {
    for (const rows of both(history, 'Track Type')) {
      expect(summary(rows)).toEqual([
        ['Oval', 1],
        ['Road Course (Long)', 1],
        ['Street Course', 3],
      ]);
    }
  });

  it('leaves an uncategorised race out of Track Type only (AC4.2.3; BR1.7, BR1.8)', () => {
    const [overall] = both(history, 'Track Type');
    expect(overall.reduce((sum, r) => sum + r.starts, 0)).toBe(5);
    const { splitGroupsOverall } = groupsOf(history);
    expect(summary(rowsOf(splitGroupsOverall, 'Layout'))).toContainEqual(['Mystery', 1]);
    expect(summary(rowsOf(splitGroupsOverall, 'Weather'))).toEqual([
      ['Dry', 4],
      ['Wet', 2],
    ]);
  });

  it('gives an empty Track Type group when no race is categorised (AC4.2.4; BR1.9)', () => {
    const plain = history.map((r) => ({ ...r, layoutCategory: null }));
    for (const rows of both(plain, 'Track Type')) expect(rows).toEqual([]);
  });

  it('takes its labels from the shared category list (BR1.1, BR1.6)', () => {
    expect(TRACK_TYPE_LABELS).toEqual(LAYOUT_CATEGORY_ORDER.map((c) => LAYOUT_CATEGORY_LABELS[c]));
    expect(TRACK_TYPE_LABELS).toEqual([
      'Oval',
      'Roval',
      'Road Course (Long)',
      'Road Course (Short)',
      'Street Course',
    ]);
    expect(WEATHER_LABELS).toEqual(['Dry', 'Wet']);
  });

  it('builds the new rows with the same columns as a Layout row (BR1.10)', () => {
    const { splitGroupsOverall } = groupsOf(history);
    const columns = Object.keys(rowsOf(splitGroupsOverall, 'Layout')[0]).sort();
    expect(Object.keys(rowsOf(splitGroupsOverall, 'Weather')[0]).sort()).toEqual(columns);
    expect(Object.keys(rowsOf(splitGroupsOverall, 'Track Type')[0]).sort()).toEqual(columns);
  });
});
