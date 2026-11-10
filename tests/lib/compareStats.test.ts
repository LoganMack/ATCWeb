/**
 * Compare (FR4.4-FR4.10, BR4.2-BR4.10): drivers, teams credited per round and cars credited per round, the
 * team titles, hidden-driver labels, slot keys, and the Percent denominators of the Timing tower redesign
 * (FR3.4-FR3.6): races the filters cover, races entered, race laps and finished seasons.
 */
import { describe, expect, it } from 'vitest';
import type { Season } from '../../src/lib/db/seasons';
import type { DriverBasic, TeamBasic } from '../../src/lib/results/rows';
import {
  aggregateDriverCareerStats,
  type CareerRound,
  type DriverCareerSeasonRow,
  type DriverCareerStats,
  type TeamSeasonTitles,
} from '../../src/lib/results/careerStats';
import { emptyCounts, resolveClassFilter, type StatCounts } from '../../src/lib/results/classFilter';
import {
  buildCompareLists,
  compareQuery,
  compareSeasonOptions,
  resolveCompareSeason,
  type CompareInput,
} from '../../src/lib/results/compareStats';
import {
  COMPARE_ROWS,
  formatEntityKey,
  formatPercentValue,
  parseEntityKey,
  percentOf,
  resolvePicks,
  type CompareEntity,
} from '../../src/lib/compareRows';

const CLASSES = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Gamma' },
  { id: 3, name: 'Delta' },
];
const S17 = { id: 's17', name: 'ATC17', number: 17, is_current: false } as Season;
const S18 = { id: 's18', name: 'ATC18', number: 18, is_current: true } as Season;

const counts = (c: Partial<StatCounts> = {}): StatCounts => ({ ...emptyCounts(), ...c });

function round(
  subsessionId: number,
  teamId: string | null,
  carName: string | null,
  classWins = 0,
  overallWins = 0,
): CareerRound {
  return {
    subsessionId,
    teamId,
    carName,
    starts: 2,
    laps: 30,
    lapsLed: 1,
    classCounts: counts({ wins: classWins }),
    overallCounts: counts({ wins: overallWins }),
  };
}

function seasonRow(season: Season, classId: number, roundsRaced: CareerRound[]): DriverCareerSeasonRow {
  const sum = (pick: (r: CareerRound) => number) => roundsRaced.reduce((n, r) => n + pick(r), 0);
  const classCounts = counts({ wins: sum((r) => r.classCounts.wins) });
  return {
    season,
    classId,
    className: CLASSES.find((c) => c.id === classId)!.name,
    ...classCounts,
    starts: sum((r) => r.starts),
    appearances: roundsRaced.length,
    laps: sum((r) => r.laps),
    lapsLed: sum((r) => r.lapsLed),
    incidents: 2,
    totalCorners: 30,
    classPosition: 2,
    overallPosition: 3,
    teamPosition: null,
    deltaTeamPosition: null,
    cars: [],
    teams: [],
    classCounts,
    overallCounts: counts({ wins: sum((r) => r.overallCounts.wins) }),
    rounds: roundsRaced,
  };
}

function careerOf(
  driver: Partial<DriverBasic> & { id: string },
  rows: DriverCareerSeasonRow[],
): DriverCareerStats {
  return aggregateDriverCareerStats({ name: driver.id, photo_url: null, ...driver } as DriverBasic, rows);
}

const teams: TeamBasic[] = [
  { id: 'tA', name: 'Apex', logo_url: null },
  { id: 'tB', name: 'Boost', logo_url: 'https://example.invalid/b.png' },
];

// d1 races Alpha for Apex, then moves to Boost mid-season; d2 races Delta for Boost; d3 is hidden.
const careers = [
  careerOf({ id: 'd1', name: 'Ann Able' }, [
    seasonRow(S17, 1, [
      round(1, 'tA', 'Honda Civic Type R TCR', 1, 1),
      round(2, 'tB', 'Honda Civic Type R TCR', 1, 0),
    ]),
  ]),
  careerOf({ id: 'd2', name: 'Bob Brisk' }, [
    seasonRow(S17, 3, [round(1, 'tB', 'Audi RS3 LMS Gen2 TCR', 1, 0), round(2, null, null, 0, 0)]),
    seasonRow(S18, 3, [round(3, 'tB', 'Audi RS3 LMS Gen2 TCR', 1, 0)]),
  ]),
  careerOf({ id: 'd3', name: 'Hidden Driver', is_hidden: true, photo_url: null }, [
    seasonRow(S17, 2, [round(1, 'tA', 'Honda Civic Type R TCR', 0, 0)]),
  ]),
];
const teamTitles: TeamSeasonTitles[] = [
  // Boost won the overall team title in ATC17 though Apex's Ann was the primary-team driver with more wins.
  { season: S17, overallChampionIds: ['tB'], deltaChampionIds: ['tB'] },
  { season: S18, overallChampionIds: ['tB'], deltaChampionIds: ['tB'] },
];

function lists(classValue: string | null, season: Season | null = null) {
  const input: CompareInput = {
    careers,
    teamTitles,
    filter: resolveClassFilter(classValue, CLASSES),
    season,
    teams,
    carLogos: [{ car_name: 'Honda Civic Type R TCR', logo_url: 'https://example.invalid/h.png' }],
  };
  return buildCompareLists(input);
}

const byKey = (list: CompareEntity[], key: string) => list.find((e) => e.key === key);

describe('team and car crediting (BR4.6-BR4.8)', () => {
  it('credits each round to the team raced for, so a mid-season move splits the season', () => {
    const { teams: t } = lists('Combined', S17);
    // Apex: d1 round 1 + d3 round 1. Boost: d1 round 2 + d2 round 1 (d2's round 2 has no team).
    expect(byKey(t, 't:tA')).toMatchObject({ starts: 4, wins: 1, laps: 60 });
    expect(byKey(t, 't:tB')).toMatchObject({ starts: 4, wins: 2, laps: 60 });
  });

  it('uses the overall counts under Overall and only the chosen class under a class', () => {
    expect(byKey(lists(null, S17).teams, 't:tA')?.wins).toBe(1);
    expect(byKey(lists(null, S17).teams, 't:tB')?.wins).toBe(0);
    expect(byKey(lists('Delta').teams, 't:tB')).toMatchObject({ starts: 4, wins: 2 });
    expect(byKey(lists('Delta').teams, 't:tA')).toBeUndefined();
  });

  it('credits a car with every driver start in it and leaves rounds with no team or car uncredited', () => {
    const { cars } = lists('Combined');
    expect(byKey(cars, 'c:Honda Civic Type R TCR')).toMatchObject({
      starts: 6,
      wins: 2,
      championships: null,
      cornersPerIncident: null,
      href: '/cars',
    });
    expect(byKey(cars, 'c:Audi RS3 LMS Gen2 TCR')?.starts).toBe(4);
    expect(cars.map((c) => c.key)).not.toContain('c:null');
  });

  it('drops entities with no starts under the filter', () => {
    const gamma = lists('Gamma');
    expect(gamma.drivers.map((d) => d.key)).toEqual(['h:1']);
    expect(gamma.teams.map((t) => t.key)).toEqual(['t:tA']);
    expect(lists('Alpha', S18).drivers).toEqual([]);
  });
});

describe('team titles and hidden drivers (BR4.3, BR4.7)', () => {
  it('reads team titles from the team standings, finished seasons only, and shows a dash under Alpha or Gamma', () => {
    expect(byKey(lists(null).teams, 't:tB')?.championships).toBe(1); // ATC18 is still running
    expect(byKey(lists(null).teams, 't:tA')?.championships).toBe(0);
    expect(byKey(lists('Delta').teams, 't:tB')?.championships).toBe(1);
    expect(byKey(lists('Alpha').teams, 't:tA')?.championships).toBeNull();
  });

  it('labels a hidden driver "Hidden Driver N" under the opaque key h:N, with no photo or link', () => {
    const hidden = byKey(lists(null).drivers, 'h:1');
    expect(hidden).toMatchObject({ name: 'Hidden Driver 1', imageUrl: null, href: null });
    expect(byKey(lists(null).drivers, 'd:d1')).toMatchObject({ name: 'Ann Able', href: '/drivers/d1' });
    expect(parseEntityKey('h:1')).toEqual({ type: 'driver', id: '1' });
  });

  it('never puts a hidden driver’s id in the data, and a d:<hidden id> pick leaves the slot empty', () => {
    const secretId = '5f0c-hidden-uuid';
    const hiddenCareers = [
      ...careers,
      careerOf({ id: secretId, name: 'Hidden Driver', is_hidden: true, photo_url: null }, [
        seasonRow(S17, 2, [round(9, 'tA', 'Honda Civic Type R TCR', 0, 0)]),
      ]),
    ];
    for (const classValue of [null, 'Combined', 'Gamma']) {
      const data = buildCompareLists({
        careers: hiddenCareers,
        teamTitles,
        filter: resolveClassFilter(classValue, CLASSES),
        season: null,
        teams,
        carLogos: [],
      });
      const json = JSON.stringify(data);
      expect(json).not.toContain(secretId);
      expect(json).not.toContain('d:d3');
      expect(data.drivers.filter((d) => d.key.startsWith('h:')).map((d) => [d.key, d.name])).toEqual([
        ['h:1', 'Hidden Driver 1'],
        ['h:2', 'Hidden Driver 2'],
      ]);
      // Numbered over every hidden driver by id, whatever the filter: the new id sorts before d3.
      expect(resolvePicks(data, [`d:${secretId}`, 'd:d3', 'h:2', null]).map((e) => e?.name ?? null)).toEqual([
        null,
        null,
        'Hidden Driver 2',
        null,
      ]);
    }
  });
});

describe('a driver with two class rows in one season (BR3.5, BR4.7)', () => {
  // d4 raced Alpha and Gamma in ATC17 for Boost; both rows carry the same overall P1 and team.
  const twoClass = careerOf({ id: 'd4', name: 'Dee Double' }, [
    {
      ...seasonRow(S17, 1, [round(1, 'tB', 'Honda Civic Type R TCR', 1, 1)]),
      classPosition: 1,
      overallPosition: 1,
    },
    {
      ...seasonRow(S17, 2, [round(2, 'tB', 'Honda Civic Type R TCR', 1, 1)]),
      classPosition: 1,
      overallPosition: 1,
    },
  ]);

  function twoClassLists(classValue: string | null, titles = teamTitles) {
    return buildCompareLists({
      careers: [twoClass],
      teamTitles: titles,
      filter: resolveClassFilter(classValue, CLASSES),
      season: null,
      teams,
      carLogos: [],
    });
  }

  it('counts the season’s Overall title once, while Combined keeps both class titles', () => {
    expect(byKey(twoClassLists(null).drivers, 'd:d4')?.championships).toBe(1);
    expect(byKey(twoClassLists('Combined').drivers, 'd:d4')?.championships).toBe(2);
  });

  it('counts the team title once per season, even if the season is listed twice', () => {
    expect(byKey(twoClassLists(null).teams, 't:tB')?.championships).toBe(1);
    const doubled = [teamTitles[0], { ...teamTitles[0] }, teamTitles[1]];
    expect(byKey(twoClassLists(null, doubled).teams, 't:tB')?.championships).toBe(1);
    expect(byKey(twoClassLists('Delta', doubled).teams, 't:tB')).toBeUndefined(); // no Delta starts
  });
});

describe('slot keys and car rows (BR4.4, BR4.9)', () => {
  it('shows a car’s win rate per start and dashes the rows that do not apply to it', () => {
    const car = byKey(lists('Combined').cars, 'c:Audi RS3 LMS Gen2 TCR')!;
    const row = (key: string) => COMPARE_ROWS.find((r) => r.key === key)!;
    expect(formatPercentValue(row('wins').percent(car, { races: 3 }))).toBe('50.0%');
    expect(row('championships').total.format(car)).toBe('—');
    expect(row('cpi').total.format(car)).toBe('—');
    expect(car.championshipSeasons).toBeNull();
  });

  it('round-trips slot keys and rejects anything else', () => {
    for (const [type, id] of [
      ['driver', 'b7c1'],
      ['team', 't-9'],
      ['car', '[Legacy] Audi RS3 LMS TCR'],
    ] as const) {
      expect(parseEntityKey(formatEntityKey(type, id))).toEqual({ type, id });
    }
    for (const bad of ['', 'x:1', 'd:', 'driver', null]) expect(parseEntityKey(bad)).toBeNull();
  });
});

describe('Percent denominators (FR3.4-FR3.6, NFR4)', () => {
  const S16 = { id: 's16', name: 'ATC16', number: 16, is_current: false } as Season;

  function raced(
    subsessionId: number,
    teamId: string,
    carName: string,
    starts: number,
    laps: number,
  ): CareerRound {
    return {
      subsessionId,
      teamId,
      carName,
      starts,
      laps,
      lapsLed: 0,
      classCounts: counts(),
      overallCounts: counts(),
    };
  }

  // Round 10 (ATC17) has two races, run multiclass. Alpha's leader does 40 laps, Gamma's 34. Team X runs two
  // Alpha cars in both races; Ace Three missed one race. Round 11 (ATC18, still running) is one Alpha race.
  const field = [
    careerOf({ id: 'a1', name: 'Ace One' }, [
      seasonRow(S17, 1, [raced(10, 'tX', 'Car One', 2, 40)]),
      seasonRow(S18, 1, [raced(11, 'tX', 'Car One', 1, 20)]),
    ]),
    careerOf({ id: 'a2', name: 'Ace Two' }, [seasonRow(S17, 1, [raced(10, 'tX', 'Car One', 2, 38)])]),
    careerOf({ id: 'a3', name: 'Ace Three' }, [seasonRow(S17, 1, [raced(10, 'tY', 'Car Two', 1, 18)])]),
    careerOf({ id: 'g1', name: 'Gil Gamma' }, [seasonRow(S17, 2, [raced(10, 'tY', 'Car Two', 2, 34)])]),
    careerOf({ id: 'dl', name: 'Del Delta' }, [seasonRow(S17, 3, [raced(10, 'tY', 'Car Three', 2, 30)])]),
  ];
  const fieldTitles: TeamSeasonTitles[] = [
    { season: S16, overallChampionIds: ['tX'], deltaChampionIds: [] },
    { season: S17, overallChampionIds: ['tY'], deltaChampionIds: ['tY'] },
    { season: S18, overallChampionIds: ['tX'], deltaChampionIds: ['tX'] },
  ];
  const fieldTeams: TeamBasic[] = [
    { id: 'tX', name: 'Team X', logo_url: null },
    { id: 'tY', name: 'Team Y', logo_url: null },
  ];

  function fieldLists(classValue: string | null, season: Season | null = null) {
    return buildCompareLists({
      careers: field,
      teamTitles: fieldTitles,
      filter: resolveClassFilter(classValue, CLASSES),
      season,
      teams: fieldTeams,
      carLogos: [],
    });
  }

  const startsPercent = (e: CompareEntity | undefined, races: number) => percentOf(e!.racesEntered, races);

  it('counts the races the filters cover: all of them, only a class’s, or only one season’s', () => {
    expect(fieldLists(null).races).toBe(3); // round 10's two races and round 11's one
    expect(fieldLists('Combined').races).toBe(3);
    expect(fieldLists('Alpha').races).toBe(3);
    expect(fieldLists('Gamma').races).toBe(2); // Gamma never ran round 11
    expect(fieldLists(null, S18).races).toBe(1);
    expect(fieldLists('Gamma', S18).races).toBe(0);
  });

  it('narrows the Starts % denominator with the class and season filters (targeted regression)', () => {
    const overall = fieldLists(null);
    const gamma = fieldLists('Gamma');
    expect(startsPercent(byKey(overall.drivers, 'd:g1'), overall.races)).toBeCloseTo(66.67, 2);
    expect(startsPercent(byKey(gamma.drivers, 'd:g1'), gamma.races)).toBe(100);
    const atc18 = fieldLists(null, S18);
    expect(startsPercent(byKey(atc18.drivers, 'd:a1'), atc18.races)).toBe(100);
  });

  it('counts a race once for a team with two cars in it, so team and car Starts % never pass 100%', () => {
    const { races, teams, cars } = fieldLists(null);
    const teamX = byKey(teams, 't:tX')!;
    expect(teamX).toMatchObject({ starts: 5, racesEntered: 3 });
    expect(byKey(cars, 'c:Car One')).toMatchObject({ starts: 5, racesEntered: 3 });
    for (const e of [...teams, ...cars]) {
      expect(startsPercent(e, races), e.key).toBeLessThanOrEqual(100);
    }
  });

  it('scales race laps by the races a driver started, so missing one of two doesn’t halve the rate', () => {
    const ace3 = byKey(fieldLists(null).drivers, 'd:a3')!;
    expect(ace3).toMatchObject({ laps: 18, raceLaps: 20, racesEntered: 1 }); // half of the leader's 40
    expect(percentOf(ace3.laps, ace3.raceLaps)).toBe(90);
    // A full-distance driver never has fewer race laps than laps completed.
    expect(byKey(fieldLists(null).drivers, 'd:a1')).toMatchObject({ laps: 60, raceLaps: 60 });
  });

  it('measures multiclass laps against the driver’s own class leader, and sums a team’s over its rounds', () => {
    const { drivers, teams } = fieldLists(null);
    expect(byKey(drivers, 'd:g1')).toMatchObject({ laps: 34, raceLaps: 34 }); // not Alpha's 40
    // Team X: Ace One 40 + 20 and Ace Two 38, against 40 + 20 + 40.
    expect(byKey(teams, 't:tX')).toMatchObject({ laps: 98, raceLaps: 100 });
  });

  it('counts finished seasons: every one, a class’s own, or the Delta team competition’s', () => {
    const driverSeasons = (classValue: string | null, season: Season | null = null) =>
      byKey(fieldLists(classValue, season).drivers, 'd:a1')?.championshipSeasons;
    expect(driverSeasons(null)).toBe(2); // ATC16 and ATC17; ATC18 is still running
    expect(driverSeasons('Combined')).toBe(2);
    expect(driverSeasons('Alpha')).toBe(1); // Alpha's rows are ATC17 and the running ATC18
    expect(driverSeasons(null, S17)).toBe(1);
    expect(byKey(fieldLists(null).teams, 't:tY')?.championshipSeasons).toBe(2);
    expect(byKey(fieldLists('Delta').teams, 't:tY')?.championshipSeasons).toBe(1); // ATC16 had no Delta title
    expect(byKey(fieldLists('Alpha').teams, 't:tX')?.championshipSeasons).toBeNull();
  });

  it('gives an unfinished chosen season no finished seasons, so Championship % is a dash', () => {
    const ace1 = byKey(fieldLists(null, S18).drivers, 'd:a1')!;
    expect(ace1.championshipSeasons).toBe(0);
    const row = COMPARE_ROWS.find((r) => r.key === 'championships')!;
    expect(formatPercentValue(row.percent(ace1, { races: 1 }))).toBe('—');
  });
});

describe('the Season filter (FR4.1, BR5.2)', () => {
  const EXHIBITION = { id: 'sx', name: 'Winter Cup', number: 99, is_current: false } as Season;
  const seasons = [S17, S18, EXHIBITION];

  it('addresses a championship season by number and treats anything else as All', () => {
    expect(resolveCompareSeason('17', seasons)).toBe(S17);
    for (const value of [null, 'all', 'ATC17', '99', '5', '12345']) {
      expect(resolveCompareSeason(value, seasons), String(value)).toBeNull();
    }
  });

  it('lists All then the championship seasons newest first, each keeping the class', () => {
    const delta = resolveClassFilter('Delta', CLASSES);
    expect(compareSeasonOptions('/advanced-stats', delta, S17, seasons)).toEqual([
      { label: 'All seasons', href: '/advanced-stats?class=Delta', selected: false },
      { label: 'ATC18', href: '/advanced-stats?class=Delta&season=18', selected: false },
      { label: 'ATC17', href: '/advanced-stats?class=Delta&season=17', selected: true },
    ]);
    expect(compareQuery(resolveClassFilter(null, CLASSES), null)).toBe('');
  });
});
