/**
 * Series iRating maths (BR1.5): iRacing's classic method, the TypeScript reference for the database's
 * private.rating_race(). The database is the only writer of stored ratings (NFR4); this module exists so the
 * formula has hand-worked tests and so the SQL fixture can be checked against the same numbers. It runs in
 * the browser too, so it must stay free of server-only imports.
 */

/** Every rating starts here before a driver's first counted race in it (BR1.4). */
export const RATING_START = 1350;

/** The scale: 1600 / ln 2. */
export const RATING_SCALE = 1600 / Math.LN2;

/**
 * The chance that a driver rated `a` finishes ahead of one rated `b`. Equal ratings give exactly 0.5; the
 * degenerate 0/0 case (both ratings 0) is also 0.5 rather than NaN.
 */
export function winChance(a: number, b: number): number {
  const ea = Math.exp(-a / RATING_SCALE);
  const eb = Math.exp(-b / RATING_SCALE);
  const denominator = (1 - eb) * ea + (1 - ea) * eb;
  return denominator === 0 ? 0.5 : ((1 - ea) * eb) / denominator;
}

/**
 * The rating change of every driver in one field, given their ratings before the race in finishing order
 * (index 0 is P1). Everyone moves at once from their before-race rating (simultaneous update). Decimals are
 * kept; only display rounds. A field of fewer than two drivers changes nobody (BR1.6).
 */
export function ratingChanges(ratingsInFinishingOrder: readonly number[]): number[] {
  const n = ratingsInFinishingOrder.length;
  if (n < 2) return ratingsInFinishingOrder.map(() => 0);
  return ratingsInFinishingOrder.map((rating, index) => {
    const position = index + 1;
    // Self included: winChance(r, r) is 0.5, which the - 0.5 cancels.
    let expected = -0.5;
    for (const other of ratingsInFinishingOrder) expected += winChance(rating, other);
    const fudge = (n / 2 - position) / 100;
    return ((n - position - expected - fudge) * 200) / n;
  });
}

/** The ratings after one field, in the same order as given. */
export function ratingsAfter(ratingsInFinishingOrder: readonly number[]): number[] {
  const changes = ratingChanges(ratingsInFinishingOrder);
  return ratingsInFinishingOrder.map((rating, i) => rating + changes[i]);
}

/**
 * Replays races in order from the given starting ratings: each race is a list of driver keys in finishing
 * order. A driver missing from `start` starts at RATING_START. Returns the ratings after each race (only the
 * drivers in that race) and the final ratings.
 */
export function replayRaces(
  start: ReadonlyMap<string, number>,
  races: readonly (readonly string[])[],
): { afterEachRace: Map<string, number>[]; final: Map<string, number> } {
  const current = new Map(start);
  const afterEachRace: Map<string, number>[] = [];
  for (const race of races) {
    const before = race.map((key) => current.get(key) ?? RATING_START);
    const after = ratingsAfter(before);
    const step = new Map<string, number>();
    race.forEach((key, i) => {
      current.set(key, after[i]);
      step.set(key, after[i]);
    });
    afterEachRace.push(step);
  }
  return { afterEachRace, final: current };
}

/** Display rounding: half away from zero, as Postgres rounds numeric values. */
export function roundRating(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}
