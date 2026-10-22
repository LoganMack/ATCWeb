/**
 * Not automated (no place to track or enforce them): rule 58 (DSQ instead of a reset when the PP limit is hit
 * in the final round) and rule 62 (10-round ban for hitting it again on probation). The admin UI shows a note
 * so stewards handle them by hand.
 */

import { effectivePenaltyPoints, type PenaltyLike } from './effective';

// ---------------------------------------------------------------------------
// Penalty points (PP), warnings & probation — rules 57-62
// ---------------------------------------------------------------------------

export interface DriverPPState {
  penalty_points: number;
  penalty_points_max: number;
  on_probation: boolean;
  probation_started_at: string | null;
}

/**
 * Whether probation is still in effect on `today`. Rule 61: N rounds or M days, whichever is longer; "rounds"
 * are scheduled calendar rounds, not this driver's starts (Logan). Defaults are the rulebook's 45/4; the
 * admin values (0041) are passed in. Runs on its own clock across seasons.
 */
export function isOnProbationNow(
  driver: { on_probation: boolean; probation_started_at: string | null },
  events: { event_date: string }[],
  today: Date = new Date(),
  probationDays: number = 45,
  probationRounds: number = 4,
): boolean {
  if (!driver.on_probation || !driver.probation_started_at) return false;
  const start = new Date(`${driver.probation_started_at}T00:00:00`);
  const daysElapsed = (today.getTime() - start.getTime()) / 86_400_000;
  // Probation that starts after `today` isn't in effect yet. computeSeasonPPState
  // seeds its replay with the driver's stored (latest) probation, so without
  // this every penalty logged before that probation began counted double.
  if (daysElapsed < 0) return false;
  if (daysElapsed < probationDays) return true;

  const todayStr = today.toISOString().slice(0, 10);
  const roundsElapsed = events.filter(
    (e) => e.event_date > driver.probation_started_at! && e.event_date <= todayStr,
  ).length;
  return roundsElapsed < probationRounds;
}

export interface ApplyPPResult {
  state: DriverPPState;
  /** True when this award pushed the driver's total to/past the limit and triggered a reset + (re-)entry into probation — surfaced so the caller can show a steward-facing reminder about rules 58/62 (see this file's header). */
  hitLimit: boolean;
  /** True when hitLimit is true AND the driver was already on probation when it happened — rule 62's 10-round-ban trigger, not automated (see header). */
  repeatDuringProbation: boolean;
}

/**
 * Adds one penalty's PP to the tally, doubled while on probation (rule 60); reaching the limit resets to 0
 * and starts or renews probation, discarding any excess (Logan).
 */
export function applyPenaltyPointsToDriver(
  driver: DriverPPState,
  awardedPoints: number,
  isCurrentlyOnProbation: boolean,
  today: Date = new Date(),
): ApplyPPResult {
  if (awardedPoints <= 0) return { state: driver, hitLimit: false, repeatDuringProbation: false };

  const earned = isCurrentlyOnProbation ? awardedPoints * 2 : awardedPoints;
  const newTotal = driver.penalty_points + earned;

  if (newTotal >= driver.penalty_points_max) {
    return {
      state: {
        ...driver,
        penalty_points: 0,
        on_probation: true,
        probation_started_at: today.toISOString().slice(0, 10),
      },
      hitLimit: true,
      repeatDuringProbation: isCurrentlyOnProbation,
    };
  }

  return { state: { ...driver, penalty_points: newTotal }, hitLimit: false, repeatDuringProbation: false };
}

export interface SeasonPPState {
  penalty_points: number;
  on_probation: boolean;
  probation_started_at: string | null;
}

/**
 * A driver's season PP tally, replayed from 0 over this season's penalties in entry order, so PP stays
 * season-scoped (Logan), edits and deletions need no undo, and probation doubling (rule 60) is judged as of
 * each penalty. Probation is seeded from the driver's stored state, since it outlives seasons. `penalties`
 * must already be filtered to this driver and season.
 */
export function computeSeasonPPState(
  driver: { penalty_points_max: number; on_probation: boolean; probation_started_at: string | null },
  penalties: (PenaltyLike & { created_at: string })[],
  events: { event_date: string }[],
): SeasonPPState {
  return replaySeasonPP(driver, probationSeed(driver, penalties, events), penalties, events);
}

type ProbationSeed = { on_probation: boolean; probation_started_at: string | null };

/**
 * The probation a season replay starts from. When the replay reaches the stored start date itself, these
 * penalties produced it, so seeding it too would double everything before it (the start is only a date). Any
 * other stored probation is kept as the seed.
 */
function probationSeed(
  driver: { penalty_points_max: number; on_probation: boolean; probation_started_at: string | null },
  penalties: (PenaltyLike & { created_at: string })[],
  events: { event_date: string }[],
): ProbationSeed {
  const stored = { on_probation: driver.on_probation, probation_started_at: driver.probation_started_at };
  if (!stored.on_probation || !stored.probation_started_at) return stored;
  const unseeded = replaySeasonPP(
    driver,
    { on_probation: false, probation_started_at: null },
    penalties,
    events,
  );
  return unseeded.on_probation && unseeded.probation_started_at === stored.probation_started_at
    ? { on_probation: false, probation_started_at: null }
    : stored;
}

function replaySeasonPP(
  driver: { penalty_points_max: number },
  seed: ProbationSeed,
  penalties: (PenaltyLike & { created_at: string })[],
  events: { event_date: string }[],
): SeasonPPState {
  let state: DriverPPState = { penalty_points: 0, penalty_points_max: driver.penalty_points_max, ...seed };

  const sorted = [...penalties].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  for (const p of sorted) {
    const awarded = effectivePenaltyPoints(p);
    if (awarded <= 0) continue;
    const asOf = new Date(p.created_at);
    const wasOnProbation = isOnProbationNow(state, events, asOf);
    state = applyPenaltyPointsToDriver(state, awarded, wasOnProbation, asOf).state;
  }

  return {
    penalty_points: state.penalty_points,
    on_probation: state.on_probation,
    probation_started_at: state.probation_started_at,
  };
}

export interface RoundPPSummary {
  /** Season PP tally going into this round. */
  before: number;
  /** Season PP tally after this round's penalties. */
  after: number;
  /** PP this round actually added, after any probation doubling (rule 60) — what was awarded, not what's left after a reset. */
  earned: number;
  /** Whether any of this round's PP counted double because the driver was on probation. */
  doubled: boolean;
  /** Whether this round's PP reached the season limit, triggering the reset + probation (and, by hand, rules 58/62). */
  hitLimit: boolean;
}

/**
 * One driver's season PP before and after one round, for the Incident Report summary: earlier rounds replayed
 * like computeSeasonPPState, then this round's penalties one by one to see doubling and limit hits. Ordered
 * by round, then entry; differs from computeSeasonPPState only when an earlier round's penalty was logged
 * after a later one's.
 */
export function computeRoundPPSummary(
  driver: { penalty_points_max: number; on_probation: boolean; probation_started_at: string | null },
  earlierPenalties: (PenaltyLike & { created_at: string })[],
  roundPenalties: (PenaltyLike & { created_at: string })[],
  events: { event_date: string }[],
): RoundPPSummary {
  // Seed from the season so far (this round included), so a probation this
  // round triggered isn't also seeded into the replay before it.
  const seed = probationSeed(driver, [...earlierPenalties, ...roundPenalties], events);
  const before = replaySeasonPP(driver, seed, earlierPenalties, events);
  let state: DriverPPState = { ...before, penalty_points_max: driver.penalty_points_max };
  let earned = 0;
  let doubled = false;
  let hitLimit = false;

  const sorted = [...roundPenalties].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  for (const p of sorted) {
    const awarded = effectivePenaltyPoints(p);
    if (awarded <= 0) continue;
    const asOf = new Date(p.created_at);
    const wasOnProbation = isOnProbationNow(state, events, asOf);
    const result = applyPenaltyPointsToDriver(state, awarded, wasOnProbation, asOf);
    earned += wasOnProbation ? awarded * 2 : awarded;
    doubled ||= wasOnProbation;
    hitLimit ||= result.hitLimit;
    state = result.state;
  }

  return { before: before.penalty_points, after: state.penalty_points, earned, doubled, hitLimit };
}

/** Counts is_warning penalties from an already season-filtered list — see getPenaltiesForSeason. Kept as a tiny function (rather than inlining) so both the per-driver dialog note and any future season-wide tally read it the same way. */
export function countWarnings(penalties: { is_warning: boolean }[]): number {
  return penalties.filter((p) => p.is_warning).length;
}
