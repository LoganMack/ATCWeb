/**
 * The home page Previous Result card's pure parts: the Alpha and Delta Team tabs (FR4.3-FR4.5) and the car and
 * team logos on Qualifying and Practice rows (FR4.2). No Supabase calls.
 */
import { describe, expect, it } from 'vitest';
import {
  alphaTeamRows,
  deltaTeamRows,
  firstRaceCarTeam,
  teamTabRows,
} from '../../src/lib/results/previousResult';
import type { RaceResultRow, RoundResults } from '../../src/lib/results/roundResults';

const ALPHA = 1;
const GAMMA = 2;
const DELTA = 3;
const classes = [{ id: ALPHA }, { id: GAMMA }, { id: DELTA }];

function row(
  driverId: string,
  classId: number,
  team: string | null,
  totalPoints: number,
  classPoints = 0,
  extra: Partial<RaceResultRow> = {},
): RaceResultRow {
  return {
    raceNumber: 1,
    classId,
    position: 1,
    dsq: false,
    driver: { id: driverId, name: driverId } as RaceResultRow['driver'],
    totalPoints,
    classPoints,
    team: team ? { name: team, logoUrl: `${team}.png` } : null,
    car: { name: `${driverId} car`, logoUrl: null },
    ...extra,
  } as RaceResultRow;
}

function byClassFor(race: number, rows: RaceResultRow[]): RoundResults['byClass'] {
  const out: RoundResults['byClass'] = new Map();
  for (const r of rows) {
    if (!out.has(r.classId)) out.set(r.classId, new Map());
    const races = out.get(r.classId)!;
    if (!races.has(race)) races.set(race, []);
    races.get(race)!.push(r);
  }
  return out;
}

describe('Previous Result Alpha Team tab (FR4.3)', () => {
  const rows = [
    row('a1', ALPHA, 'Mixed', 40),
    row('g1', GAMMA, 'Mixed', 38, 8),
    row('g2', GAMMA, 'Gamma Only', 30, 8),
    row('g3', GAMMA, 'Gamma Only', 20, 4),
    row('d1', DELTA, 'Delta Only', 90, 10),
    row('d2', DELTA, 'Mixed', 80, 10),
  ];
  const byClass = byClassFor(1, rows);

  it('counts drivers of every class, Delta included, by points without class points', () => {
    // Mixed: d2 70 + a1 40 (g1's 30 is its third row); Delta Only: d1 80; Gamma Only: g2 22 + g3 16.
    expect(alphaTeamRows(byClass, classes, 1)).toEqual([
      { teamName: 'Mixed', teamLogoUrl: 'Mixed.png', points: 110, position: 1 },
      { teamName: 'Delta Only', teamLogoUrl: 'Delta Only.png', points: 80, position: 2 },
      { teamName: 'Gamma Only', teamLogoUrl: 'Gamma Only.png', points: 38, position: 3 },
    ]);
  });

  it('keeps the Delta Team rule: Delta drivers only, by class total (FR4.4)', () => {
    expect(deltaTeamRows(byClass, DELTA, 1)).toEqual([
      { teamName: 'Delta Only', teamLogoUrl: 'Delta Only.png', points: 90, position: 1 },
      { teamName: 'Mixed', teamLogoUrl: 'Mixed.png', points: 80, position: 2 },
    ]);
  });

  it('gives no tab rows for a race with no results', () => {
    expect(alphaTeamRows(byClass, classes, 2)).toEqual([]);
    expect(deltaTeamRows(byClass, DELTA, 2)).toEqual([]);
  });
});

describe('teamTabRows (FR4.3, FR4.5)', () => {
  const plain = (r: RaceResultRow) => r.totalPoints;

  it('sums only the top two rows, and a team with one row scores that row', () => {
    const rows = [row('a', ALPHA, 'Three', 10), row('b', ALPHA, 'Three', 30), row('c', ALPHA, 'Three', 20)];
    rows.push(row('d', ALPHA, 'Solo', 45));
    expect(teamTabRows(rows, plain).map((t) => [t.teamName, t.points])).toEqual([
      ['Three', 50],
      ['Solo', 45],
    ]);
  });

  it('leaves out disqualified rows and rows with no team', () => {
    const rows = [
      row('a', ALPHA, 'Kept', 10),
      row('b', ALPHA, 'Kept', 99, 0, { dsq: true }),
      row('c', ALPHA, null, 99),
    ];
    expect(teamTabRows(rows, plain)).toEqual([
      { teamName: 'Kept', teamLogoUrl: 'Kept.png', points: 10, position: 1 },
    ]);
  });

  it('breaks ties as the Race Results winner does: best row, best class position, then name', () => {
    const at = (position: number) => ({ position });
    // Equal 30s: Peak's best row 25 beats Even's 15.
    const byBestRow = [
      row('a', ALPHA, 'Even', 15, 0, at(1)),
      row('b', ALPHA, 'Even', 15, 0, at(2)),
      row('c', ALPHA, 'Peak', 25, 0, at(5)),
      row('d', ALPHA, 'Peak', 5, 0, at(6)),
    ];
    expect(teamTabRows(byBestRow, plain).map((t) => t.teamName)).toEqual(['Peak', 'Even']);
    // Equal totals and best rows: Front's class P1 beats Back's P3.
    const byPosition = [row('a', ALPHA, 'Back', 20, 0, at(3)), row('b', GAMMA, 'Front', 20, 0, at(1))];
    expect(teamTabRows(byPosition, plain).map((t) => t.teamName)).toEqual(['Front', 'Back']);
    // Everything equal: by team name.
    const byName = [row('a', ALPHA, 'Zulu', 20, 0, at(1)), row('b', GAMMA, 'Alpha Co', 20, 0, at(1))];
    expect(teamTabRows(byName, plain).map((t) => t.teamName)).toEqual(['Alpha Co', 'Zulu']);
  });

  it('keeps the top five teams', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`d${n}`, ALPHA, `Team ${n}`, n * 10));
    const out = teamTabRows(rows, plain);
    expect(out).toHaveLength(5);
    expect(out.map((t) => t.position)).toEqual([1, 2, 3, 4, 5]);
    expect(out[0].teamName).toBe('Team 7');
  });
});

describe('firstRaceCarTeam (FR4.2)', () => {
  it("takes each driver's car and team from the lowest race number", () => {
    const overall = new Map<number, RaceResultRow[]>([
      [2, [row('a1', ALPHA, 'Later Team', 10, 0, { car: { name: 'Race 2 car', logoUrl: null } })]],
      [1, [row('a1', ALPHA, 'First Team', 10), row('g1', GAMMA, 'Gamma Team', 5)]],
    ]);
    const map = firstRaceCarTeam(overall);
    expect(map.get('a1')).toEqual({
      car: { name: 'a1 car', logoUrl: null },
      team: { name: 'First Team', logoUrl: 'First Team.png' },
    });
    expect(map.get('g1')?.team?.name).toBe('Gamma Team');
  });

  it('has no entry for a driver who did not race in the first race', () => {
    const overall = new Map<number, RaceResultRow[]>([
      [1, [row('a1', ALPHA, 'First Team', 10)]],
      [2, [row('q9', ALPHA, 'Race 2 Team', 10)]],
    ]);
    expect(firstRaceCarTeam(overall).has('q9')).toBe(false);
  });

  it('is empty when the round has no race results', () => {
    expect(firstRaceCarTeam(new Map()).size).toBe(0);
  });
});
