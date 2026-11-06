/**
 * Career rows with classless Overall counts and per-round team and car (FR3.2-FR3.5, BR3.2-BR3.6): the stored
 * path on the captured ATC17 season, the live path's round shape, and the filter-aware aggregate.
 */
import { describe, expect, it } from 'vitest';
import { exhibitionIds, inputs, scores, season } from '../golden/atc17';
import { perRoundFromRaceRows } from '../golden/roundRows';
import { toPenalty } from '../../src/lib/db/penalties';
import type { Season } from '../../src/lib/db/seasons';
import type { RoundWithLayout } from '../../src/lib/results/rounds';
import type { DriverBasic, TeamBasic } from '../../src/lib/results/rows';
import type { DriverSeasonStanding, StandingsRoundStat } from '../../src/lib/results/standingsCore';
import { overallStandingsFromRounds, seasonRoundStatsFrom } from '../../src/lib/results/roundStatsAdapter';
import {
  aggregateCareer,
  aggregateDriverCareerStats,
  isFilterChampion,
  seasonCareerRows,
  storedSeasonCareerRows,
  type DriverCareerSeasonRow,
  type SeasonViews,
} from '../../src/lib/results/careerStats';
import { emptyCounts, resolveClassFilter, type StatCounts } from '../../src/lib/results/classFilter';

// ---- The stored path on ATC17 -----------------------------------------------------------------------------
const penalties = inputs.penalties.map(toPenalty);
const stored = perRoundFromRaceRows({
  scores,
  rawResults: inputs.rawResults,
  drivers: inputs.drivers,
  penalties,
  classes: inputs.classes,
  postedIds: new Set(scores.map((s) => s.subsession_id)),
});
const rounds: RoundWithLayout[] = inputs.seasonRounds.map((r) => ({ ...r, layout: null }));
const stats = seasonRoundStatsFrom(season, rounds, exhibitionIds, stored);
const teams: TeamBasic[] = [
  ...new Set(scores.map((s) => s.team_id).filter((t): t is string => t !== null)),
].map((id) => ({ id, name: `Team ${id.slice(0, 8)}`, logo_url: null }));
const refs = {
  drivers: inputs.drivers,
  teams,
  carLogos: [],
  seasonLogoRows: [],
  circuits: [],
  layouts: [],
  rulesets: inputs.rulesets,
};
const career = storedSeasonCareerRows(stats, inputs.classes, refs, { withRounds: true });
const allRows = [...career.rowsByDriver.values()].flat();

describe('per-round lists only on request (Compare)', () => {
  it('builds no rounds by default, with the same rows and counts otherwise', () => {
    const plain = storedSeasonCareerRows(stats, inputs.classes, refs);
    const plainRows = [...plain.rowsByDriver.values()].flat();
    expect(plainRows.length).toBe(allRows.length);
    expect(plainRows.every((r) => r.rounds.length === 0)).toBe(true);
    expect(allRows.every((r) => r.rounds.length > 0)).toBe(true);
    expect(plainRows.map(({ rounds: _r, ...rest }) => rest)).toEqual(
      allRows.map(({ rounds: _r, ...rest }) => rest),
    );
  });
});

describe('the stored path on ATC17 (BR3.2)', () => {
  it('gives each season row the driver’s counts from the classless Overall standings', () => {
    const overall = overallStandingsFromRounds(stats, {
      drivers: inputs.drivers,
      rulesets: inputs.rulesets,
      classes: inputs.classes,
    });
    expect(overall.length).toBeGreaterThan(0);
    for (const standing of overall) {
      const rows = career.rowsByDriver.get(standing.driver.id) ?? [];
      const sum = rows.reduce((n, r) => n + r.overallCounts.wins, 0);
      expect(sum, standing.driver.name).toBe(standing.wins);
      expect(
        rows.reduce((n, r) => n + r.overallCounts.poles, 0),
        standing.driver.name,
      ).toBe(standing.poles);
    }
  });

  it('counts fewer overall wins than class wins, since each class has its own winner but a race has one', () => {
    const classWins = allRows.reduce((n, r) => n + r.classCounts.wins, 0);
    const overallWins = allRows.reduce((n, r) => n + r.overallCounts.wins, 0);
    expect(overallWins).toBeGreaterThan(0);
    expect(classWins).toBeGreaterThan(overallWins);
    // Some driver won their class without winning overall.
    expect(allRows.some((r) => r.classCounts.wins > r.overallCounts.wins)).toBe(true);
  });

  it('gives every round the team and car stored for it, summing to the season row', () => {
    const storedByKey = new Map(stats.driverRows.map((r) => [`${r.driver_id}:${r.subsession_id}`, r]));
    for (const [driverId, rows] of career.rowsByDriver) {
      for (const row of rows) {
        expect(row.rounds.length).toBeGreaterThan(0);
        expect(row.rounds.reduce((n, r) => n + r.starts, 0)).toBe(row.starts);
        expect(row.rounds.reduce((n, r) => n + r.classCounts.wins, 0)).toBe(row.wins);
        for (const round of row.rounds) {
          const src = storedByKey.get(`${driverId}:${round.subsessionId}`)!;
          expect(round.teamId).toBe(src.team_id);
          expect(round.carName).toBe(Object.keys(src.cars)[0] ?? null);
        }
      }
    }
  });

  it('records the team competition winners of the season', () => {
    expect(career.teamTitles).toHaveLength(1);
    expect(career.teamTitles[0].overallChampionIds).toHaveLength(1);
  });
});

// ---- The live path's round shape ---------------------------------------------------------------------------
function roundStat(counts: Partial<StatCounts> & { starts?: number; laps?: number }): StandingsRoundStat {
  return { ...emptyCounts(), starts: 2, laps: 40, lapsLed: 3, ...counts };
}

function standing(
  id: string,
  position: number,
  roundStats: [number, StandingsRoundStat][],
): DriverSeasonStanding {
  const sum = (k: keyof StandingsRoundStat) => roundStats.reduce((n, [, r]) => n + r[k], 0);
  return {
    driver: { id, name: id } as DriverBasic,
    position,
    totalPoints: 0,
    starts: sum('starts'),
    appearances: roundStats.length,
    wins: sum('wins'),
    podiums: sum('podiums'),
    top5s: sum('top5s'),
    top10s: sum('top10s'),
    poles: sum('poles'),
    lapsLed: sum('lapsLed'),
    laps: sum('laps'),
    roundCells: new Map(),
    roundStats: new Map(roundStats),
  };
}

describe('the live path (FD section 1)', () => {
  it('builds the same round shape from the standings, with the primary team and most-raced car', () => {
    const live: SeasonViews = {
      season: { id: 's9', name: 'ATC9', number: 9, is_current: false } as Season,
      classStandings: [
        [
          standing('d1', 1, [
            [11, roundStat({ wins: 1 })],
            [12, roundStat({ wins: 1 })],
          ]),
        ],
        [],
        [],
      ],
      overallStandings: [
        standing('d1', 2, [
          [11, roundStat({ wins: 0 })],
          [12, roundStat({ wins: 1 })],
        ]),
      ],
      extendedStats: new Map(),
      teamOverall: [],
      teamDelta: [],
      carTeamStats: new Map([
        [
          'd1',
          {
            cars: [{ carName: 'Honda Civic Type R TCR', logoUrl: null, races: 3 }],
            teams: [
              { teamId: 't1', teamName: 'T1', logoUrl: null, racesUnderTeam: 4, racesScoredForTeam: 4 },
            ],
          },
        ],
      ]),
      roundTeamCar: null,
    };
    expect(seasonCareerRows([live], inputs.classes).rowsByDriver.get('d1')![0].rounds).toEqual([]);
    const row = seasonCareerRows([live], inputs.classes, { withRounds: true }).rowsByDriver.get('d1')![0];
    expect(
      row.rounds.map((r) => [r.subsessionId, r.teamId, r.carName, r.classCounts.wins, r.overallCounts.wins]),
    ).toEqual([
      [11, 't1', 'Honda Civic Type R TCR', 1, 0],
      [12, 't1', 'Honda Civic Type R TCR', 1, 1],
    ]);
    expect(row.overallCounts.wins).toBe(1);
    expect(row.classCounts.wins).toBe(2);
    expect(row.overallPosition).toBe(2);
  });
});

// ---- The filter-aware aggregate ----------------------------------------------------------------------------
const CLASSES = inputs.classes;
const classId = (name: string) => CLASSES.find((c) => c.name === name)!.id;

function seasonRow(
  name: string,
  className: string,
  classCounts: Partial<StatCounts>,
  overallCounts: Partial<StatCounts>,
  extra: Partial<DriverCareerSeasonRow> = {},
): DriverCareerSeasonRow {
  const cc = { ...emptyCounts(), ...classCounts };
  return {
    season: { id: name, name, number: Number(name.slice(3)), is_current: false } as Season,
    classId: classId(className),
    className,
    ...cc,
    starts: 10,
    appearances: 5,
    laps: 100,
    lapsLed: 7,
    incidents: 4,
    totalCorners: 80,
    classPosition: 3,
    overallPosition: 5,
    teamPosition: null,
    deltaTeamPosition: null,
    cars: [],
    teams: [],
    classCounts: cc,
    overallCounts: { ...emptyCounts(), ...overallCounts },
    rounds: [],
    ...extra,
  };
}

const driver = { id: 'd1', name: 'Driver One' } as DriverBasic;
// 2 Gamma wins (one also first overall) + 1 Alpha win at P2 overall.
const rows = [
  seasonRow('ATC18', 'Gamma', { wins: 2 }, { wins: 1 }, { classPosition: 1, overallPosition: 4 }),
  seasonRow(
    'ATC17',
    'Alpha',
    { wins: 1, poles: 1 },
    { wins: 0, poles: 1 },
    { classPosition: 2, overallPosition: 1 },
  ),
  seasonRow('ATC19', 'Gamma', { wins: 1 }, { wins: 1 }, { classPosition: 1, overallPosition: 1 }),
];
rows[2].season.is_current = true;

describe('aggregateCareer (BR3.2-BR3.6)', () => {
  it('sums classless counts under Overall and counts titles from the overall position, not the current season', () => {
    const agg = aggregateCareer(driver, rows, resolveClassFilter(null, CLASSES));
    expect(agg.wins).toBe(2);
    expect(agg.championships).toBe(1); // ATC17 at overall P1; ATC19 is still running
    expect(isFilterChampion(rows[1], resolveClassFilter(null, CLASSES))).toBe(true);
    expect(isFilterChampion(rows[0], resolveClassFilter(null, CLASSES))).toBe(false);
  });

  it('keeps Combined equal to the old summed totals: 2 Gamma wins + 1 Alpha win = 3 (+1 current)', () => {
    const agg = aggregateCareer(driver, rows, resolveClassFilter('Combined', CLASSES));
    expect(agg).toEqual(aggregateDriverCareerStats(driver, rows));
    expect(agg.wins).toBe(4);
    expect(agg.championships).toBe(1); // the ATC18 Gamma title
  });

  it('keeps only one class’s seasons under a class, and shares starts and laps between Overall and Combined', () => {
    const gamma = aggregateCareer(driver, rows, resolveClassFilter('Gamma', CLASSES));
    expect(gamma.seasons.map((r) => r.season.name)).toEqual(['ATC18', 'ATC19']);
    expect(gamma.wins).toBe(3);
    const overall = aggregateCareer(driver, rows, resolveClassFilter(null, CLASSES));
    const combined = aggregateCareer(driver, rows, resolveClassFilter('Combined', CLASSES));
    expect([overall.starts, overall.laps, overall.lapsLed]).toEqual([
      combined.starts,
      combined.laps,
      combined.lapsLed,
    ]);
    expect(overall.cornersPerIncident).toBe(combined.cornersPerIncident);
    expect(aggregateCareer(driver, rows, resolveClassFilter('Delta', CLASSES)).starts).toBe(0);
  });

  it('counts an Overall title once for a season with two class rows', () => {
    // Both ATC16 rows carry the season's overall P1; Combined still counts each class title.
    const twoClass = [
      seasonRow('ATC16', 'Alpha', { wins: 1 }, { wins: 1 }, { classPosition: 1, overallPosition: 1 }),
      seasonRow('ATC16', 'Gamma', { wins: 2 }, { wins: 1 }, { classPosition: 1, overallPosition: 1 }),
      ...rows,
    ];
    const overall = aggregateCareer(driver, twoClass, resolveClassFilter(null, CLASSES));
    expect(overall.championships).toBe(2); // ATC16 once + ATC17
    expect(overall.wins).toBe(4);
    expect(aggregateCareer(driver, twoClass, resolveClassFilter('Combined', CLASSES)).championships).toBe(3);
  });
});
