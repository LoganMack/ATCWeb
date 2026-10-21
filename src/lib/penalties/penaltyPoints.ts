/**
 * DOCUMENTED SIMPLIFICATIONS (deliberately out of scope for this pass):
 *   - Rule 58 (DSQ instead of reset if the PP limit is hit in the season's
 *     final round) and rule 62 (10-round ban for hitting the limit again
 *     while already on probation) aren't automated — both describe
 *     real-world consequences this app has nowhere to track or enforce.
 *     The admin UI surfaces a note when either applies so stewards handle
 *     it manually.
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
 * Whether a driver's probation is still in effect as of `today` (defaults
 * to right now). Rule 61: "Probation lasts for either N rounds or M days,
 * whichever is longer" — confirmed with Logan that "rounds" means every
 * scheduled calendar round, not just ones this driver actually starts, so
 * this counts events rather than race_scores appearances. Requiring both
 * conditions to clear (probationDays elapsed AND probationRounds qualifying
 * rounds passed) is equivalent to "whichever threshold is later."
 *
 * probationDays/probationRounds default to the rulebook's original 45/4
 * (rule 61), but as of 0041_driver_settings.sql they're admin-editable from
 * the "Driver Settings" panel above the admin Drivers list —
 * src/pages/roster.astro (the only real caller) loads them from
 * site_settings and passes them through, so the defaults here only apply if
 * a future caller forgets to.
 *
 * Probation runs on this independent calendar clock regardless of season
 * boundaries — only the PP tally that triggers it (computeSeasonPPState) is
 * season-scoped.
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
 * Applies one penalty's PP award to a driver's running tally, doubling it
 * first if they're currently mid-probation (rule 60), and triggers the
 * hard-reset-to-0 + enter/renew-probation behavior once the total reaches
 * the limit (confirmed with Logan: any amount over the limit is simply
 * discarded, not carried over).
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
 * Recomputes a driver's PP TALLY from scratch by replaying every penalty
 * logged against them THIS SEASON, in entry order — rather than
 * incrementally mutating a stored counter on each new penalty (the
 * v0.13/v0.14 approach). Replaying means:
 *   - PP is season-scoped (confirmed with Logan: "penalty points... should
 *     be season-scoped, not career-scoped") — a penalty from a previous
 *     season isn't in `penalties`' input list, so it can't contribute here,
 *     however long ago the tally was last touched.
 *   - Editing or deleting a penalty correctly ripples through: since this
 *     always starts the tally from 0 and replays the current set of season
 *     penalties, there's no separate "undo" step — the caller just re-runs
 *     this and persists the result after any mutation.
 *   - Doubling-during-probation (rule 60) still applies correctly even
 *     retroactively, since each step checks whether probation was active
 *     AS OF that specific penalty's created_at.
 *
 * Probation itself is NOT reset to this function's season scope — it's
 * seeded from `driver`'s ACTUAL on_probation/probation_started_at, since
 * rule 61 probation runs its own 45-day/4-round calendar clock independent
 * of season boundaries. A driver whose probation was triggered by a penalty
 * from a PREVIOUS season and is still active today must stay on probation
 * here; replaying only this season's penalties must never silently clear
 * that. If none of this season's penalties push the tally to a fresh
 * limit-hit, the returned on_probation/probation_started_at just pass the
 * seed through unchanged.
 *
 * `penalties` should be pre-filtered to this driver and the current season
 * by the caller (getPenaltiesForSubsessions + getCurrentSeasonRounds in
 * src/lib/supabase.ts / src/lib/results.ts) — this function doesn't filter
 * itself.
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
 * The probation a season replay starts from. The stored probation is the
 * driver's latest one, so when replaying `penalties` from scratch arrives at
 * that same start date, these penalties produced it and the replay re-derives
 * it at the right penalty — seeding it as well would double everything logged
 * before it began (probation_started_at is a date, so isOnProbationNow can't
 * tell apart penalties logged earlier that same day). Any other stored
 * probation (a previous season's, or one set by hand on the driver page) is
 * kept as the seed, per the doc comment above.
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
 * One driver's season PP going into and coming out of one round — the
 * Incident Report's cumulative summary table. Replays `earlierPenalties` (the
 * season's rounds before this one) the same way computeSeasonPPState does,
 * then this round's own penalties one at a time so it can tell whether they
 * were doubled or hit the limit. Both lists should already be filtered to
 * this driver. The ordering is by round, then entry order within a round —
 * computeSeasonPPState orders the whole season by entry time alone, so the
 * two only disagree when an earlier round's penalty was logged after a later
 * round's.
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
