/**
 * Series iRating maths (src/lib/rating/iRating.ts; BR1.4-BR1.6, NFR7): the formula worked by hand for three
 * drivers, its symmetry, that a winner never loses rating, separate class fields, and a parity sample from the
 * Season 15 iRating sheet. The sample is two races of real before and after ratings with the drivers left out
 * (anonymous by position only); the sheet stores whole numbers, so each value must match within 1 point.
 */
import { describe, expect, it } from 'vitest';
import {
  RATING_START,
  ratingChanges,
  ratingsAfter,
  replayRaces,
  roundRating,
  winChance,
} from '../../src/lib/rating/iRating';

/** Season 15 race 1 (40 starters) and race 5 (42 starters): ratings before and after, in finishing order. */
const SEASON_15 = [
  {
    before: [
      4396, 5378, 4337, 3530, 4302, 3585, 3098, 2822, 2667, 2823, 2565, 1722, 2454, 1824, 1391, 1557, 1699, 2039,
      1771, 1780, 2810, 1265, 1661, 897, 944, 1350, 1013, 1614, 1778, 1302, 1350, 1350, 1215, 667, 930, 1350, 860,
      1350, 956, 1350,
    ],
    after: [
      4434, 5399, 4366, 3568, 4322, 3611, 3130, 2856, 2700, 2846, 2590, 1769, 2472, 1857, 1436, 1590, 1721, 2045,
      1781, 1785, 2779, 1281, 1655, 920, 959, 1342, 1015, 1585, 1738, 1276, 1317, 1312, 1178, 652, 896, 1292, 820,
      1282, 901, 1272,
    ],
  },
  {
    before: [
      4526, 3538, 4517, 5446, 4348, 1350, 4396, 2609, 3568, 1754, 3235, 2911, 1774, 1590, 2779, 1456, 2026, 1414,
      1396, 1836, 813, 2062, 1270, 1109, 2696, 938, 1272, 1061, 1631, 1907, 1229, 1230, 1185, 1350, 1311, 632, 895,
      968, 1410, 1243, 953, 1195,
    ],
    after: [
      4561, 3585, 4544, 5457, 4368, 1440, 4406, 2648, 3581, 1809, 3245, 2924, 1815, 1633, 2781, 1494, 2039, 1445,
      1422, 1842, 858, 2051, 1283, 1124, 2652, 952, 1266, 1060, 1601, 1863, 1206, 1203, 1155, 1308, 1266, 617, 861,
      925, 1342, 1177, 896, 1122,
    ],
  },
];

describe('winChance', () => {
  it('is exactly a coin flip for equal ratings and favours the higher rating', () => {
    expect(winChance(1350, 1350)).toBe(0.5);
    expect(winChance(0, 0)).toBe(0.5);
    expect(winChance(2000, 1000)).toBeGreaterThan(0.5);
    expect(winChance(2000, 1000) + winChance(1000, 2000)).toBeCloseTo(1, 12);
  });
});

describe('ratingChanges', () => {
  it('works the three-driver example by hand (all at the start rating)', () => {
    // n = 3, expected = 1 for everyone; fudge = (1.5 - p) / 100.
    const [p1, p2, p3] = ratingChanges([RATING_START, RATING_START, RATING_START]);
    expect(p1).toBeCloseTo(((3 - 1 - 1 - 0.005) * 200) / 3, 10);
    expect(p2).toBeCloseTo(((3 - 2 - 1 + 0.005) * 200) / 3, 10);
    expect(p3).toBeCloseTo(((3 - 3 - 1 + 0.015) * 200) / 3, 10);
    expect(ratingsAfter([1350, 1350, 1350]).map(roundRating)).toEqual([1416, 1350, 1284]);
  });

  it('is mirror-symmetric for equal ratings apart from the fudge term', () => {
    const changes = ratingChanges(Array.from({ length: 6 }, () => 1500));
    for (let i = 0; i < 3; i++) {
      const fudgeI = (3 - (i + 1)) / 100;
      const fudgeJ = (3 - (6 - i)) / 100;
      // change_i + change_j = (fudge-free sum) - (fudge_i + fudge_j) * 200 / n, and the fudges cancel.
      expect(changes[i] + changes[5 - i]).toBeCloseTo((-(fudgeI + fudgeJ) * 200) / 6, 10);
      expect(changes[i]).toBeGreaterThan(0);
      expect(changes[5 - i]).toBeLessThan(0);
    }
  });

  it('never takes rating from the winner, even a heavy favourite', () => {
    for (const field of [
      [5000, 1000, 1000, 1000],
      [9000, 300],
      [1350, 1350],
      [4000, 3999, 3998, 3997, 3996, 3995, 3994, 3993, 3992, 3991],
    ]) {
      expect(ratingChanges(field)[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it('changes nobody in a field of fewer than two (BR1.6)', () => {
    expect(ratingChanges([1700])).toEqual([0]);
    expect(ratingChanges([])).toEqual([]);
  });
});

describe('replayRaces', () => {
  it('rates each class field on its own, starting new drivers at 1350 (BR1.4)', () => {
    const overall = replayRaces(new Map(), [['g1', 'a1', 'g2', 'a2', 'd1']]);
    const alpha = replayRaces(new Map(), [['a1', 'a2']]);
    const gamma = replayRaces(new Map(), [['g1', 'g2']]);
    // A class field is smaller, so the same finish moves the rating differently.
    expect(alpha.final.get('a1')).not.toBeCloseTo(overall.final.get('a1')!, 3);
    expect(gamma.final.get('g1')).toBeGreaterThan(RATING_START);
    expect(alpha.final.has('g1')).toBe(false);
    expect(overall.afterEachRace).toHaveLength(1);
  });

  it('carries each driver from race to race and leaves absent drivers unchanged', () => {
    const start = new Map([['x', 1800]]);
    const { afterEachRace, final } = replayRaces(start, [
      ['a', 'b'],
      ['b', 'x'],
    ]);
    expect(afterEachRace[0].has('x')).toBe(false);
    const [b2, x2] = ratingsAfter([afterEachRace[0].get('b')!, 1800]);
    expect(final.get('b')).toBe(b2);
    expect(final.get('x')).toBe(x2);
  });
});

describe('Season 15 sheet parity (NFR7)', () => {
  it.each(SEASON_15.map((race, i) => [i + 1, race] as const))('sample race %i matches within 1 point', (_, race) => {
    const after = ratingsAfter(race.before);
    after.forEach((value, i) => {
      expect(Math.abs(value - race.after[i]), `finisher ${i + 1}`).toBeLessThanOrEqual(1);
    });
  });
});

describe('roundRating', () => {
  it('rounds half away from zero, as Postgres rounds numerics', () => {
    expect(roundRating(1416.5)).toBe(1417);
    expect(roundRating(-38.5)).toBe(-39);
    expect(roundRating(0.4)).toBe(0);
  });
});
