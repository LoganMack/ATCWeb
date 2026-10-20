/**
 * The standings page's "as of round N" total, shared by the Standings by Round slider and the
 * graph's Drop Weeks toggle (src/pages/standings.astro). Runs in the browser.
 *
 * `points` holds one entry per round column in page order (null = the driver didn't race it, counted
 * as 0). Only the first `n` columns count. Once `n` reaches `minDropRounds`, the worst `drops` rounds
 * are dropped, always keeping at least one; unless `canDropFinalRound`, column n-1 (the latest visible
 * round) is never dropped. Ties drop the higher column index. `dropped` holds column indexes.
 *
 * This mirrors finalizeStandings in src/lib/results.ts, which works on the season's round pool
 * instead of the visible columns; the two agree on totals when every column is visible and the
 * season's final round is the last one (see tests/lib/seasonTotals.test.ts).
 */
export function totalAsOf(
  points: (number | null)[],
  n: number,
  drops: number,
  minDropRounds: number,
  canDropFinalRound: boolean,
): { total: number; dropped: Set<number> } {
  const pool = points.slice(0, n).map((p, i) => ({ i, p: p ?? 0 }));
  const totalDrops = n >= minDropRounds ? drops : 0;
  const dropped = new Set<number>();
  let total: number;
  if (!canDropFinalRound && n >= 1) {
    const finalPts = pool[n - 1].p;
    const rest = pool.slice(0, n - 1).sort((a, b) => b.p - a.p || a.i - b.i);
    const dropCount = Math.min(totalDrops, Math.max(0, n - 1));
    const keep = Math.max(0, rest.length - dropCount);
    total = finalPts + rest.slice(0, keep).reduce((s, r) => s + r.p, 0);
    rest.slice(keep).forEach((r) => dropped.add(r.i));
  } else {
    const ranked = [...pool].sort((a, b) => b.p - a.p || a.i - b.i);
    const dropCount = Math.min(totalDrops, Math.max(0, ranked.length - 1));
    total = ranked.slice(0, ranked.length - dropCount).reduce((s, r) => s + r.p, 0);
    ranked.slice(ranked.length - dropCount).forEach((r) => dropped.add(r.i));
  }
  return { total, dropped };
}
