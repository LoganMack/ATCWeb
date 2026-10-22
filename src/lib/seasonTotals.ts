/**
 * Season totals: the one place drop weeks, the tiebreak order and the "as of round N" total are
 * defined (BR5.1). finalizeStandings (src/lib/results/standingsCore.ts) uses them on the server and
 * the standings page script (src/pages/standings.astro) in the browser, so this module must stay
 * free of server-only imports.
 */

/** One round in a driver's drop-week pool. `order` breaks a points tie: the higher order drops first. */
export interface PoolRound {
  order: number;
  points: number;
}

/** How many rounds drop: none until `roundsRaced` reaches `minDropRounds`, then `drops`. */
export function dropsFor(roundsRaced: number, drops: number, minDropRounds: number): number {
  return roundsRaced >= minDropRounds ? drops : 0;
}

/**
 * Drops the worst `drops` rounds of `pool`, always keeping at least one. A round whose order equals
 * `protectedOrder` is never dropped (a ruleset's final round), and the drops come from the rest.
 * Returns the counted total and the orders of the dropped rounds.
 */
export function dropWorstRounds(
  pool: PoolRound[],
  drops: number,
  protectedOrder: number | null,
): { total: number; dropped: Set<number> } {
  const byPointsDesc = (a: PoolRound, b: PoolRound) => b.points - a.points || a.order - b.order;
  const dropped = new Set<number>();
  const dropCount = Math.min(drops, Math.max(0, pool.length - 1));
  const kept = protectedOrder === null ? null : pool.find((r) => r.order === protectedOrder);
  const ranked = (kept ? pool.filter((r) => r !== kept) : [...pool]).sort(byPointsDesc);
  const keep = Math.max(0, ranked.length - dropCount);
  let total = kept ? kept.points : 0;
  ranked.forEach((r, i) => {
    if (i < keep) total += r.points;
    else dropped.add(r.order);
  });
  return { total, dropped };
}

/**
 * The page's "as of round N" total, shared by the Standings by Round slider and the graph's Drop
 * Weeks toggle. `points` holds one entry per round column in page order (null = the driver didn't
 * race it, counted as 0). Only the first `n` columns count. Unless `canDropFinalRound`, column n-1
 * (the latest visible round) is never dropped. `dropped` holds column indexes.
 */
export function totalAsOf(
  points: (number | null)[],
  n: number,
  drops: number,
  minDropRounds: number,
  canDropFinalRound: boolean,
): { total: number; dropped: Set<number> } {
  const pool = points.slice(0, n).map((p, i) => ({ order: i, points: p ?? 0 }));
  const protectedOrder = !canDropFinalRound && n >= 1 ? n - 1 : null;
  return dropWorstRounds(pool, dropsFor(n, drops, minDropRounds), protectedOrder);
}

/** What the standings rank on. A team ranks on points and name only, so its counting stats are 0. */
export interface StandingKeys {
  totalPoints: number;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  lapsLed: number;
  laps: number;
  appearances: number;
  /** The display name, compared last. */
  name: string;
}

/** Points, then wins, podiums, top 5s, top 10s, poles, laps led, laps and appearances, then name. */
export function compareStandings(a: StandingKeys, b: StandingKeys): number {
  return (
    b.totalPoints - a.totalPoints ||
    b.wins - a.wins ||
    b.podiums - a.podiums ||
    b.top5s - a.top5s ||
    b.top10s - a.top10s ||
    b.poles - a.poles ||
    b.lapsLed - a.lapsLed ||
    b.laps - a.laps ||
    b.appearances - a.appearances ||
    a.name.localeCompare(b.name)
  );
}
