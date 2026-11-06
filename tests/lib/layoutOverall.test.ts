/**
 * The Circuits overall winner and pole (FR3.10, BR3.9): built from the same race score rows and race-1 grid
 * the class winners use, across every class, with no extra read.
 */
import { describe, expect, it } from 'vitest';
import type { DriverBasic } from '../../src/lib/results/rows';
import {
  buildLayoutHighlights,
  type LayoutRoundSummary,
  type RaceOneCuratedRow,
  type RaceOneScoreRow,
} from '../../src/lib/results/layouts';

const ALPHA = 1;
const GAMMA = 2;

const drivers = ['a1', 'a2', 'g1', 'g2'].map(
  (id, i) => ({ id, name: id, iracing_cust_id: 100 + i }) as DriverBasic,
);
const cust = (id: string) => drivers.find((d) => d.id === id)!.iracing_cust_id!;

const roundOf = (subsessionId: number, startTime: string): LayoutRoundSummary => ({
  subsessionId,
  trackName: 'Lime Rock',
  startTime,
  seasonLabel: 'ATC18',
  displayRoundNumber: null,
});
const rounds = [
  roundOf(10, '2026-01-01T00:00:00Z'),
  roundOf(20, '2026-03-01T00:00:00Z'),
  roundOf(30, '2026-05-01T00:00:00Z'),
];

function score(
  subsession_id: number,
  driver_id: string,
  class_id: number,
  shown_position: number | null,
  extra: Partial<RaceOneScoreRow> = {},
): RaceOneScoreRow {
  return {
    subsession_id,
    race_number: 1,
    driver_id,
    class_id,
    shown_position,
    classified: true,
    dsq: false,
    ...extra,
  };
}

const grid = (
  subsession_id: number,
  driverId: string,
  starting_position: number | null,
): RaceOneCuratedRow => ({
  subsession_id,
  cust_id: cust(driverId),
  starting_position,
});

const scores: RaceOneScoreRow[] = [
  // Round 10: a Gamma car crosses the line first overall.
  score(10, 'g1', GAMMA, 1),
  score(10, 'a1', ALPHA, 2),
  score(10, 'a2', ALPHA, 3),
  // Round 20: the first car home is disqualified, and an unclassified row has a better shown position.
  score(20, 'a1', ALPHA, 1, { dsq: true }),
  score(20, 'g2', GAMMA, 2, { classified: false }),
  score(20, 'a2', ALPHA, 3),
  // Round 30: only an unclassified row.
  score(30, 'g1', GAMMA, 1, { classified: false }),
];
const curated = [
  grid(10, 'a1', 2),
  grid(10, 'g1', 1),
  grid(20, 'a2', 4),
  grid(20, 'g2', 3),
  grid(30, 'g1', 1),
];

describe('buildLayoutHighlights overall entries (BR3.9)', () => {
  const h = buildLayoutHighlights(rounds, drivers, scores, curated, false);

  it('picks the lowest shown position across every class as the overall winner', () => {
    const r10 = h.overallWinners.find((w) => w.round.subsessionId === 10)!;
    expect(r10.driver.id).toBe('g1');
    // The Alpha class winner of that round is still listed under Alpha.
    expect(h.winnersByClass.get(ALPHA)!.find((w) => w.round.subsessionId === 10)!.driver.id).toBe('a1');
  });

  it('skips disqualified and unclassified rows', () => {
    expect(h.overallWinners.find((w) => w.round.subsessionId === 20)!.driver.id).toBe('a2');
  });

  it('gives a round with no classified rows no overall entry, and lists newest first', () => {
    expect(h.overallWinners.map((w) => w.round.subsessionId)).toEqual([20, 10]);
    expect(h.overallPoles.map((p) => p.round.subsessionId)).not.toContain(30);
    // Its class pole is listed as before.
    expect(h.polesByClass.get(GAMMA)!.map((p) => p.round.subsessionId)).toContain(30);
  });

  it('takes the overall pole from the lowest race-1 grid slot across every class', () => {
    expect(h.overallPoles.map((p) => [p.round.subsessionId, p.driver.id])).toEqual([
      [20, 'g2'],
      [10, 'g1'],
    ]);
  });

  it('gives one overall winner per race when all races are shown', () => {
    const sprint = [
      score(10, 'a1', ALPHA, 1, { race_number: 1 }),
      score(10, 'g1', GAMMA, 2, { race_number: 1 }),
      score(10, 'g1', GAMMA, 1, { race_number: 2 }),
      score(10, 'a1', ALPHA, 2, { race_number: 2 }),
    ];
    const all = buildLayoutHighlights([rounds[0]], drivers, sprint, [], true);
    expect(all.overallWinners.map((w) => [w.raceNumber, w.raceCount, w.driver.id])).toEqual([
      [1, 2, 'a1'],
      [2, 2, 'g1'],
    ]);
    expect(all.overallPoles).toEqual([]);
  });
});
