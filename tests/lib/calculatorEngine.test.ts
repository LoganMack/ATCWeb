/**
 * The points calculator engine (src/lib/calculator/engine.ts, contention.ts; BR3.1-BR3.10): drops with padding,
 * live and projected protection, statuses (Leader, In contention, Must win out, Out, Champion), the points
 * needed (cross-checked by brute force over small seasons), the Out round, and the team top-two re-pick.
 * Seasons are built by hand so every number can be worked on paper.
 */
import { describe, expect, it } from 'vitest';
import { applyEdits, countedTotal, liveRanking, runIndexes } from '../../src/lib/calculator/engine';
import { computeContention, liveTotals } from '../../src/lib/calculator/contention';
import type {
  CalculatorEntrant,
  CalculatorRound,
  CalculatorSeason,
  Edit,
} from '../../src/lib/calculator/types';

const TABLE = { finish: [50, 40, 30, 20, 10], classifiedMinimum: 1, classPoints: [] };

function round(index: number, over: Partial<CalculatorRound> = {}): CalculatorRound {
  return {
    index,
    label: `R${index}`,
    short: `R${index}`,
    order: index,
    state: 'completed',
    format: 'endurance',
    races: 1,
    tables: [TABLE],
    bestCase: 50,
    secondPlaceCase: 40,
    soloBestCase: 50,
    soloSecondPlaceCase: 40,
    isFinal: false,
    ...over,
  };
}

const NO_TIEBREAK = { wins: 0, podiums: 0, top5s: 0, top10s: 0, poles: 0, lapsLed: 0, laps: 0, appearances: 0 };

function entrant(key: string, roundPoints: (number | null)[], over: Partial<CalculatorEntrant> = {}): CalculatorEntrant {
  return { key, name: key.toUpperCase(), roundPoints, tiebreak: NO_TIEBREAK, ...over };
}

/** `completed` rounds run; the rest are future. */
function season(
  completed: number,
  total: number,
  entrants: CalculatorEntrant[],
  over: Partial<CalculatorSeason> = {},
  roundOver: (i: number) => Partial<CalculatorRound> = () => ({}),
): CalculatorSeason {
  return {
    seasonId: 's',
    seasonName: 'S',
    championship: 'overall',
    championshipLabel: 'Overall',
    isTeam: false,
    rounds: Array.from({ length: total }, (_, i) =>
      round(i + 1, { state: i < completed ? 'completed' : 'future', isFinal: i === total - 1, ...roundOver(i + 1) }),
    ),
    entrants,
    dropCount: 0,
    dropsFromRounds: 1,
    canDropFinalRound: false,
    ...over,
  };
}

const byKey = (rows: ReturnType<typeof computeContention>) => new Map(rows.map((r) => [r.key, r]));

describe('drops and protection (BR3.2)', () => {
  it('pads a missed round as a droppable zero once enough rounds have run', () => {
    const s = season(3, 3, [entrant('e', [50, null, 40])], { dropCount: 1, dropsFromRounds: 3 });
    const [row] = computeContention(s, []);
    expect(row.countedTotal).toBe(90);
    expect(row.droppedRounds).toEqual([2]);
    // Two rounds run is below dropsFromRounds: nothing drops yet.
    const early = season(2, 3, [entrant('e', [50, null, null])], { dropCount: 1, dropsFromRounds: 3 });
    expect(computeContention(early, [])[0].countedTotal).toBe(50);
  });

  it('protects the latest run round live and the last calendar round in the projection', () => {
    const s = season(3, 4, [entrant('e', [50, 40, 10, null])], { dropCount: 1, dropsFromRounds: 3 });
    const [row] = computeContention(s, []);
    // Live: round 3 is protected, so round 2's 40 drops.
    expect(row.countedTotal).toBe(60);
    expect(row.droppedRounds).toEqual([2]);
    // Projection: round 4 (0 points) is protected and round 3's 10 drops.
    expect(row.floor).toBe(90);
    const free = computeContention({ ...s, canDropFinalRound: true }, [])[0];
    expect(free.countedTotal).toBe(90);
    expect(free.droppedRounds).toEqual([3]);
  });

  it('lets the protected final round decide who is out', () => {
    const entrants = [entrant('l', [100, 100, null]), entrant('c', [0, 90, null])];
    const opts = { dropCount: 1, dropsFromRounds: 3 };
    // Protected: the leader's empty final round must count, so the floor is 100 and C's best 140.
    expect(byKey(computeContention(season(2, 3, entrants, opts), [])).get('c')!.status).not.toBe('out');
    // Droppable: the leader drops the empty round (floor 200), C's best case is 140.
    const out = byKey(computeContention(season(2, 3, entrants, { ...opts, canDropFinalRound: true }), []));
    expect(out.get('c')).toMatchObject({ status: 'out', bestCase: 140 });
    expect(out.get('l')!.floor).toBe(200);
  });

  it('counts a team pool with no drops', () => {
    const s = season(3, 3, [entrant('t', [10, 0, 5])], { isTeam: true, dropCount: 3 });
    expect(countedTotal(s, s.entrants[0].roundPoints, [0, 1, 2], 2)).toEqual({ total: 15, dropped: [] });
  });
});

describe('statuses and points needed (BR3.6-BR3.8)', () => {
  it('needs (a): without drops, the gap to the leader floor', () => {
    const s = season(2, 4, [entrant('l', [50, 50, null, null]), entrant('c', [40, 30, null, null])]);
    const c = byKey(computeContention(s, [])).get('c')!;
    expect(c).toMatchObject({ status: 'in_contention', needs: 30, bestCase: 170, floor: null });
  });

  it('needs (b): with drops, the points fill the protected final round first', () => {
    const s = season(2, 4, [entrant('l', [50, 50, null, null]), entrant('c', [30, 0, null, null])], {
      dropCount: 1,
      dropsFromRounds: 3,
    });
    const rows = byKey(computeContention(s, []));
    expect(rows.get('l')!.floor).toBe(100);
    // 50 in the protected round 4 and 20 in round 3: 30 + 20 + 50 counted, round 2's 0 dropped.
    expect(rows.get('c')!.needs).toBe(70);
  });

  it('a best case exactly at the floor is still in it, but only by winning out', () => {
    const s = season(2, 3, [entrant('l', [50, 50, null]), entrant('c', [50, 0, null])]);
    const c = byKey(computeContention(s, [])).get('c')!;
    expect(c.bestCase).toBe(100);
    expect(c).toMatchObject({ status: 'must_win_out', needs: 50 });
  });

  it('marks Must win out when one slip in a multi-race round loses it', () => {
    const multi = (i: number) => (i === 3 ? { races: 2, tables: [TABLE, TABLE], bestCase: 100, secondPlaceCase: 90 } : {});
    const s = season(2, 3, [entrant('l', [100, 100, null]), entrant('c', [100, 5, null]), entrant('d', [100, 20, null])], {}, multi);
    const rows = byKey(computeContention(s, []));
    expect(rows.get('c')).toMatchObject({ status: 'must_win_out', bestCase: 205 });
    expect(rows.get('d')).toMatchObject({ status: 'in_contention', bestCase: 220 });
  });

  it('uses the team caps for a team and the solo caps for a one-driver team', () => {
    const member = (key: string) => ({ key, name: key, racePoints: [] });
    const caps = () => ({ bestCase: 90, secondPlaceCase: 80, soloBestCase: 50, soloSecondPlaceCase: 40 });
    const s = season(
      1,
      2,
      [
        entrant('l', [150, null], { members: [member('l1'), member('l2')] }),
        entrant('pair', [65, null], { members: [member('p1'), member('p2')] }),
        entrant('solo', [65, null], { members: [member('s1')] }),
      ],
      { isTeam: true },
      caps,
    );
    const rows = byKey(computeContention(s, []));
    expect(rows.get('pair')).toMatchObject({ status: 'must_win_out', bestCase: 155 });
    expect(rows.get('solo')).toMatchObject({ status: 'out', bestCase: 115 });
  });

  it('names the round an Out entrant was first out from (BR3.9)', () => {
    const s = season(3, 4, [entrant('l', [50, 50, 50, null]), entrant('c', [40, 0, 0, null])]);
    const c = byKey(computeContention(s, [])).get('c')!;
    expect(c).toMatchObject({ status: 'out', outAfterRound: 3, needs: null });
  });

  it('crowns a Champion when no rounds remain', () => {
    const s = season(2, 2, [entrant('a', [50, 40]), entrant('b', [40, 40])]);
    expect(computeContention(s, []).map((r) => [r.key, r.status, r.needs])).toEqual([
      ['a', 'champion', null],
      ['b', 'final', null],
    ]);
  });
});

describe('needs cross-check by brute force', () => {
  /** Small deterministic generator, so a failure always reproduces. */
  function rng(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  /** The least total points over every split of the remaining rounds (each 0..cap) that reaches the floor. */
  function bruteNeeds(s: CalculatorSeason, points: (number | null)[], floor: number): number | null {
    const pool = s.rounds.map((_, i) => i);
    const remaining = s.rounds.flatMap((r, i) => (r.state === 'future' ? [i] : []));
    const protectedIndex = s.canDropFinalRound ? null : pool[pool.length - 1];
    let best: number | null = null;
    const walk = (k: number, row: (number | null)[], sum: number) => {
      if (best !== null && sum >= best) return;
      if (k === remaining.length) {
        if (countedTotal(s, row, pool, protectedIndex).total >= floor) best = sum;
        return;
      }
      const i = remaining[k];
      for (let p = 0; p <= s.rounds[i].bestCase; p++) {
        row[i] = p;
        walk(k + 1, row, sum + p);
      }
      row[i] = null;
    };
    walk(0, [...points], 0);
    return best;
  }

  it('agrees with the greedy spread on 60 random small seasons', () => {
    const next = rng(42);
    let compared = 0;
    for (let t = 0; t < 60; t++) {
      const total = 3 + Math.floor(next() * 3);
      const completed = 1 + Math.floor(next() * (total - 2));
      const caps = Array.from({ length: total }, () => 2 + Math.floor(next() * 7));
      const points = () => Array.from({ length: total }, (_, i) => (i < completed ? (next() < 0.2 ? null : Math.floor(next() * 9)) : null));
      const s = season(completed, total, [entrant('l', points()), entrant('c', points()), entrant('d', points())], {
        dropCount: Math.floor(next() * 2),
        dropsFromRounds: 2 + Math.floor(next() * 2),
        canDropFinalRound: next() < 0.3,
      }, (i) => ({ bestCase: caps[i - 1], secondPlaceCase: caps[i - 1] - 1 }));
      const rows = computeContention(s, []);
      const floor = rows.find((r) => r.floor !== null)!.floor!;
      for (const row of rows) {
        if (row.floor !== null) continue;
        const want = bruteNeeds(s, row.roundPoints, floor);
        if (row.status === 'out') expect(want, `season ${t}, ${row.key}`).toBeNull();
        else expect(row.needs, `season ${t}, ${row.key}`).toBe(want);
        compared++;
      }
    }
    expect(compared).toBe(120);
  });
});

describe('edits (BR3.10)', () => {
  const edit = (over: Partial<Edit>): Edit => ({ entrantKey: 'c', roundIndex: 3, mode: 'position', position: 1, points: 50, ...over });

  it('prices a position edit from the round table, runs the round, and moves the leader', () => {
    const s = season(2, 3, [entrant('l', [50, 50, null]), entrant('c', [50, 40, null])]);
    const rows = computeContention(s, [edit({})]);
    expect(rows.map((r) => [r.key, r.countedTotal, r.status])).toEqual([
      ['c', 140, 'champion'],
      ['l', 100, 'final'],
    ]);
    expect(liveTotals(s, [edit({ position: 4 })]).get('c')).toBe(110);
  });

  it('treats a null position as did not race and the last edit to a cell as the one that counts', () => {
    const s = season(2, 3, [entrant('c', [50, 40, null])]);
    const effective = applyEdits(s, [edit({ points: 30, mode: 'points' }), edit({ position: null })]);
    expect(effective.points[0][2]).toBeNull();
    expect(runIndexes(effective)).toEqual([0, 1, 2]);
    expect(effective.editedCells).toEqual(new Set(['c|3']));
  });

  it('ignores an edit to a special round', () => {
    const s = season(2, 3, [entrant('c', [50, 40, null])], {}, (i) => (i === 3 ? { state: 'special', bestCase: 0 } : {}));
    expect(runIndexes(applyEdits(s, [edit({})]))).toEqual([0, 1]);
  });

  it('re-picks a team’s top two per race after a member edit (BR3.1)', () => {
    const team = entrant('t', [90], {
      members: [
        { key: 'm1', name: 'M1', racePoints: [[50]] },
        { key: 'm2', name: 'M2', racePoints: [[40]] },
        { key: 'm3', name: 'M3', racePoints: [null] },
      ],
    });
    const s = season(1, 1, [team], { isTeam: true });
    const effective = applyEdits(s, [{ entrantKey: 't', memberKey: 'm3', roundIndex: 1, mode: 'position', position: 1, points: 50 }]);
    expect(effective.points[0][0]).toBe(100);
    expect(effective.memberRaces[0][2][0]).toEqual([50]);
    // The loaded season is never changed by an edit.
    expect(team.members![2].racePoints[0]).toBeNull();
    const ranking = liveRanking(s, effective.points, runIndexes(effective));
    expect(ranking[0].total).toBe(100);
  });
});
