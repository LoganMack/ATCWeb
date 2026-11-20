/**
 * Who can still win (BR3.6-BR3.9): best case, the leader's floor, the points each chaser needs, the status
 * of every row and the round an Out row names. The projection counts every remaining round as run, so its
 * protected round is the season's last calendar round (BR3.2). Browser-safe: no server imports.
 */
import { applyEdits, countedTotal, liveRanking, runIndexes, scoringRoundIndexes } from './engine';
import type { CalculatorSeason, ContentionRow, ContentionStatus, Edit } from './types';

interface Projection {
  /** Every round that can score, 0-based. */
  pool: number[];
  /** Pool rounds not yet run. */
  remaining: number[];
  /** Never dropped in the projection: the last calendar round, unless the ruleset lets it drop. */
  protectedIndex: number | null;
}

function projection(season: CalculatorSeason, run: readonly number[]): Projection {
  const pool = scoringRoundIndexes(season);
  const runSet = new Set(run);
  const last = pool.length ? pool[pool.length - 1] : null;
  return {
    pool,
    remaining: pool.filter((i) => !runSet.has(i)),
    protectedIndex: season.canDropFinalRound ? null : last,
  };
}

/** Each remaining round's cap and second-place cap for one entrant (a one-driver team uses the solo caps). */
function capsFor(season: CalculatorSeason, entrantIndex: number) {
  const solo = season.isTeam && (season.entrants[entrantIndex].members?.length ?? 0) <= 1;
  return season.rounds.map((r) => ({
    best: solo ? r.soloBestCase : r.bestCase,
    second: solo ? r.soloSecondPlaceCase : r.secondPlaceCase,
  }));
}

/** The entrant's points with the given values written into the remaining rounds. */
function withRemaining(
  points: readonly (number | null)[],
  remaining: readonly number[],
  valueOf: (roundIndex: number) => number,
): (number | null)[] {
  const out = [...points];
  for (const i of remaining) out[i] = valueOf(i);
  return out;
}

function projectedTotal(
  season: CalculatorSeason,
  proj: Projection,
  points: readonly (number | null)[],
): number {
  return countedTotal(season, points, proj.pool, proj.protectedIndex).total;
}

/**
 * BR3.6 spread: S points over the remaining rounds, the protected final round first (it always counts), then
 * the rounds with the largest cap, each filled up to its cap.
 */
export function greedySpread(
  remaining: readonly number[],
  caps: readonly number[],
  protectedIndex: number | null,
  s: number,
): Map<number, number> {
  const order = [...remaining].sort((a, b) => {
    if (a === protectedIndex) return -1;
    if (b === protectedIndex) return 1;
    return caps[b] - caps[a] || a - b;
  });
  const out = new Map<number, number>();
  let left = s;
  for (const i of order) {
    const give = Math.max(0, Math.min(caps[i], left));
    out.set(i, give);
    left -= give;
  }
  return out;
}

/**
 * The least whole number of points, spread over the remaining rounds, that lifts the entrant's counted total
 * to at least `floor` (BR3.6), or null when even every round at its cap falls short.
 */
export function pointsNeeded(
  season: CalculatorSeason,
  proj: Projection,
  points: readonly (number | null)[],
  caps: readonly number[],
  floor: number,
): number | null {
  const totalWith = (s: number) => {
    const spread = greedySpread(proj.remaining, caps, proj.protectedIndex, s);
    return projectedTotal(
      season,
      proj,
      withRemaining(points, proj.remaining, (i) => spread.get(i) ?? 0),
    );
  };
  const max = proj.remaining.reduce((sum, i) => sum + caps[i], 0);
  if (totalWith(max) < floor) return null;
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (totalWith(mid) >= floor) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface Standing {
  leader: number;
  floor: number;
  best: number[];
}

/** Leader, floor and every entrant's best case for a given run set (BR3.6). */
function standingAt(
  season: CalculatorSeason,
  points: readonly (readonly (number | null)[])[],
  run: readonly number[],
): Standing & { proj: Projection; ranking: ReturnType<typeof liveRanking> } {
  const ranking = liveRanking(season, points, run);
  const proj = projection(season, run);
  const leader = ranking[0]?.entrant ?? 0;
  const floor = projectedTotal(
    season,
    proj,
    withRemaining(points[leader] ?? [], proj.remaining, () => 0),
  );
  const best = season.entrants.map((_, i) => {
    const caps = capsFor(season, i);
    return projectedTotal(
      season,
      proj,
      withRemaining(points[i], proj.remaining, (r) => caps[r].best),
    );
  });
  return { leader, floor, best, proj, ranking };
}

/**
 * BR3.9: the earliest run round from which the entrant has been Out at every later run round, replaying the
 * season as of each run round (later rounds treated as remaining). 1-based, or null.
 */
function outAfterRound(replayAt: (k: number) => Standing, run: readonly number[], entrant: number): number | null {
  let earliest: number | null = null;
  for (let k = run.length - 1; k >= 0; k--) {
    const at = replayAt(k);
    if (at.leader === entrant || at.best[entrant] >= at.floor) break;
    earliest = run[k] + 1;
  }
  return earliest;
}

/** The standing as of the k-th run round, computed once per k and shared by every Out row. */
function replays(
  season: CalculatorSeason,
  points: readonly (readonly (number | null)[])[],
  run: readonly number[],
): (k: number) => Standing {
  const cache = new Map<number, Standing>();
  return (k) => {
    let at = cache.get(k);
    if (!at) {
      const asOf = new Set(run.slice(0, k + 1));
      // Only the rounds run by then count; later ones are remaining, whatever their result.
      const cut = points.map((row) => row.map((p, i) => (asOf.has(i) ? p : null)));
      at = standingAt(season, cut, [...asOf]);
      cache.set(k, at);
    }
    return at;
  };
}

/**
 * Use case 5: the edits applied, live totals ranked, and every row's best case, floor, needs, status and Out
 * round. Rows come back in live order.
 */
export function computeContention(season: CalculatorSeason, edits: readonly Edit[]): ContentionRow[] {
  const effective = applyEdits(season, edits);
  const run = runIndexes(effective);
  const at = standingAt(season, effective.points, run);
  const noneLeft = at.proj.remaining.length === 0;
  const replayAt = replays(season, effective.points, run);

  return at.ranking.map((row): ContentionRow => {
    const entrant = season.entrants[row.entrant];
    const isLeader = row.entrant === at.leader;
    const best = at.best[row.entrant];
    let status: ContentionStatus;
    let needs: number | null = null;
    let outAfter: number | null = null;
    if (noneLeft) {
      status = row.position === 1 ? 'champion' : 'final';
    } else if (isLeader) {
      status = 'leader';
    } else if (best < at.floor) {
      status = 'out';
      outAfter = outAfterRound(replayAt, run, row.entrant);
    } else {
      const caps = capsFor(season, row.entrant);
      needs = pointsNeeded(
        season,
        at.proj,
        effective.points[row.entrant],
        caps.map((c) => c.best),
        at.floor,
      );
      // BR3.8: one slip in any one remaining round puts the best case below the floor.
      const mustWin = at.proj.remaining.some((slipRound) => {
        const pts = withRemaining(effective.points[row.entrant], at.proj.remaining, (r) =>
          r === slipRound ? caps[r].second : caps[r].best,
        );
        return projectedTotal(season, at.proj, pts) < at.floor;
      });
      status = mustWin ? 'must_win_out' : 'in_contention';
    }
    return {
      key: entrant.key,
      name: entrant.name,
      position: row.position,
      countedTotal: row.total,
      roundPoints: effective.points[row.entrant],
      droppedRounds: row.dropped.map((i) => i + 1),
      bestCase: best,
      floor: isLeader && !noneLeft ? at.floor : null,
      needs,
      status,
      outAfterRound: outAfter,
    };
  });
}

/**
 * Use case 4 (Points Scenarios): the chaser's best case, the target's floor (the target's counted total with
 * nothing more scored) and the least points the chaser needs over the rounds left to reach it, or null when
 * the best case falls short. Null when either key is unknown.
 */
export function chaseNeeds(
  season: CalculatorSeason,
  edits: readonly Edit[],
  chaserKey: string,
  targetKey: string,
): { needs: number | null; best: number; floor: number } | null {
  const ci = season.entrants.findIndex((e) => e.key === chaserKey);
  const ti = season.entrants.findIndex((e) => e.key === targetKey);
  if (ci < 0 || ti < 0) return null;
  const effective = applyEdits(season, edits);
  const proj = projection(season, runIndexes(effective));
  const floor = projectedTotal(season, proj, withRemaining(effective.points[ti], proj.remaining, () => 0));
  const caps = capsFor(season, ci);
  const best = projectedTotal(
    season,
    proj,
    withRemaining(effective.points[ci], proj.remaining, (r) => caps[r].best),
  );
  const needs =
    best >= floor
      ? pointsNeeded(
          season,
          proj,
          effective.points[ci],
          caps.map((c) => c.best),
          floor,
        )
      : null;
  return { needs, best, floor };
}

/** Every entrant's live counted total after the edits, by key (the Scenarios verdict, use case 4). */
export function liveTotals(season: CalculatorSeason, edits: readonly Edit[]): Map<string, number> {
  const effective = applyEdits(season, edits);
  const ranking = liveRanking(season, effective.points, runIndexes(effective));
  return new Map(ranking.map((r) => [season.entrants[r.entrant].key, r.total]));
}
