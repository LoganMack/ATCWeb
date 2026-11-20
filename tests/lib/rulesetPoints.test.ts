/**
 * The calculator's points tables and best cases (src/lib/calculator/rulesetPoints.ts; BR3.4, BR3.5, BR3.8,
 * BR3.10): table choice mirrors score_round() (overrides, sprint races 2 and 3, the format table), positions past
 * the table pay the classified minimum, and the best cases add every bonus a driver or a pair of drivers can earn.
 */
import { describe, expect, it } from 'vitest';
import {
  bonusCaps,
  finishPointsAt,
  isOverrideRound,
  raceClassTable,
  raceFinishTable,
  roundCaps,
  roundPointsAt,
} from '../../src/lib/calculator/rulesetPoints';

const RULES = {
  base_points: {
    endurance: [100, 90, 80],
    sprint: [50, 45, 40],
    sprint_race2: [30, 27, 24],
    sprint_race3: [20, 18, 16],
  },
  classified_minimum: { endurance: 5, sprint: 2 },
  class_podium: { applies_to: ['Gamma'], endurance: [10, 6, 3], sprint: [5, 3, 1] },
  race_overrides: {
    subsession_ids: [777],
    base_points: { '1': [60, 50, 40] },
    classified_minimum: { '1': 1 },
  },
  bonuses: {
    lap_led: { enabled: true, endurance: 2, sprint: 1 },
    sublime_finesse: { enabled: 'true', endurance: 3, sprint: 1 },
    naked_aggression: { enabled: false, endurance: 50, sprint: 50 },
    fewest_incidents: { enabled: true, per: 'round', top_x: 1, endurance: 4, sprint: 2 },
    fastest_lap: { enabled: true, per: 'race', top_x: 1, endurance: 1, sprint: 1 },
    class_pole: { enabled: true, endurance: 5, sprint: 5 },
    sprint_sweep: { enabled: true, points: 7 },
  },
};

describe('raceFinishTable', () => {
  it('chooses the override table, then the sprint race tables, then the format table', () => {
    expect(raceFinishTable(RULES, 'endurance', 1, true)).toEqual({ finish: [60, 50, 40], classifiedMinimum: 1 });
    expect(raceFinishTable(RULES, 'sprint', 1, false).finish).toEqual([50, 45, 40]);
    expect(raceFinishTable(RULES, 'sprint', 2, false).finish).toEqual([30, 27, 24]);
    expect(raceFinishTable(RULES, 'sprint', 3, false).finish).toEqual([20, 18, 16]);
    expect(raceFinishTable(RULES, 'endurance', 2, false)).toEqual({ finish: [100, 90, 80], classifiedMinimum: 5 });
  });

  it('treats a missing or malformed ruleset as an empty table, never a throw', () => {
    expect(raceFinishTable(null, 'endurance', 1, false)).toEqual({ finish: [], classifiedMinimum: 0 });
    expect(raceFinishTable({ base_points: 'x' }, 'sprint', 2, false).finish).toEqual([]);
  });
});

describe('positions and class points', () => {
  const table = { finish: [100, 90, 80], classifiedMinimum: 5, classPoints: [10, 6, 3] };

  it('pays the classified minimum past the table and nothing for a bad position', () => {
    expect(finishPointsAt(table, 2)).toBe(90);
    expect(finishPointsAt(table, 30)).toBe(5);
    expect(finishPointsAt(table, 0)).toBe(0);
    expect(finishPointsAt(table, 1.5)).toBe(0);
  });

  it('prices a whole round in position mode, with null as did not race (BR3.10)', () => {
    expect(roundPointsAt([table, table], 1)).toBe(220);
    expect(roundPointsAt([table], 4)).toBe(5);
    expect(roundPointsAt([table], null)).toBe(0);
  });

  it('gives class points only to a class the ruleset lists', () => {
    expect(raceClassTable(RULES, 'endurance', 1, 'Gamma')).toEqual([10, 6, 3]);
    expect(raceClassTable(RULES, 'endurance', 1, 'Delta')).toEqual([]);
    expect(raceClassTable(RULES, 'endurance', 1, null)).toEqual([]);
  });
});

describe('bonusCaps and roundCaps', () => {
  it('splits bonuses into per-race and once-per-round amounts, skipping disabled ones', () => {
    expect(bonusCaps(RULES, 'endurance', 1)).toEqual({ perRace: 2 + 3 + 1, perRound: 4 + 5 });
    // The sprint sweep only counts when the sprint round has more than one race.
    expect(bonusCaps(RULES, 'sprint', 2)).toEqual({ perRace: 1 + 1 + 1, perRound: 2 + 5 + 7 });
    expect(bonusCaps(RULES, 'sprint', 1).perRound).toBe(2 + 5);
  });

  it('adds every bonus to the driver and team best cases (BR3.4, BR3.5)', () => {
    const caps = roundCaps(RULES, 'endurance', 1, { className: null });
    expect(caps.bestCase).toBe(100 + 6 + 9);
    expect(caps.secondPlaceCase).toBe(caps.bestCase - 10);
    expect(caps.teamBestCase).toBe(100 + 90 + 2 * 15);
    expect(caps.teamSecondPlaceCase).toBe(caps.teamBestCase - 10);
  });

  it('takes the smallest one-place slip across a multi-race round (BR3.8)', () => {
    const caps = roundCaps(RULES, 'sprint', 3, { className: 'Gamma' });
    // Race P1 points with class points: 55, 35, 25; P2: 48, 30, 21. Smallest slip is race 3's 4.
    const bonus = 3 * 3 + (2 + 5 + 7);
    expect(caps.bestCase).toBe(55 + 35 + 25 + bonus);
    expect(caps.secondPlaceCase).toBe(caps.bestCase - 4);
  });

  it('uses the override tables only for a listed run round', () => {
    expect(isOverrideRound(RULES, 777)).toBe(true);
    expect(isOverrideRound(RULES, 778)).toBe(false);
    expect(isOverrideRound(RULES, null)).toBe(false);
    expect(roundCaps(RULES, 'endurance', 1, { className: null }, true).races[0].finish).toEqual([60, 50, 40]);
  });
});
