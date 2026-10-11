/**
 * The rulebook's "Table: PP Penalties" (section 5, Stewarding) — what a PP
 * level costs. Kept dependency-free so the incident dialog's browser script
 * can import it too (it fills in the time penalty from the PP picked).
 *
 * Per Logan, the level is the driver's PP total for the whole ROUND (every
 * race in it), not one incident. The time part still lands on the race each
 * incident happened in, at that incident's own PP (rule: "Penalties are
 * applied to the results of the race they occurred in"); what the round
 * total adds on top — the bans and pit-lane start, which can't be applied to
 * a race that's already been run — is served at the next round. See the
 * Round Summary / Round Penalties tables on the Incident Report.
 */

export type NextRoundPenaltyKind = 'qualifying_ban' | 'pit_lane_start' | 'race_ban';

export interface PPPenaltyTier {
  /** The PP level this row is for (8 covers 8 and up). */
  pp: number;
  /** Time added to the race, in seconds — null where the table says "+1 lap" instead. */
  timeSeconds: number | null;
  extraLap: boolean;
  /** Championship points taken off. */
  pointsDeduction: number;
  /** What has to be served at the next round. */
  nextRound: NextRoundPenaltyKind[];
  /** 8+ PP: the table says "REVIEW" — stewards decide. */
  review: boolean;
}

const TIERS: PPPenaltyTier[] = [
  { pp: 1, timeSeconds: 5, extraLap: false, pointsDeduction: 0, nextRound: [], review: false },
  { pp: 2, timeSeconds: 10, extraLap: false, pointsDeduction: 0, nextRound: [], review: false },
  { pp: 3, timeSeconds: 20, extraLap: false, pointsDeduction: 0, nextRound: [], review: false },
  { pp: 4, timeSeconds: 40, extraLap: false, pointsDeduction: 0, nextRound: ['qualifying_ban'], review: false },
  { pp: 5, timeSeconds: null, extraLap: true, pointsDeduction: 10, nextRound: ['pit_lane_start'], review: false },
  { pp: 6, timeSeconds: null, extraLap: true, pointsDeduction: 50, nextRound: ['pit_lane_start'], review: false },
  { pp: 7, timeSeconds: null, extraLap: true, pointsDeduction: 100, nextRound: ['race_ban'], review: false },
  { pp: 8, timeSeconds: null, extraLap: false, pointsDeduction: 0, nextRound: [], review: true },
];

/** The table row for a PP total, or null for 0. */
export function ppPenaltyTier(pp: number): PPPenaltyTier | null {
  if (pp <= 0) return null;
  return TIERS[Math.min(pp, 8) - 1];
}

/** "+40s · Qualifying ban" — the table row as one line. */
export function describePPPenaltyTier(tier: PPPenaltyTier): string {
  if (tier.review) return 'Steward review';
  const parts: string[] = [];
  if (tier.timeSeconds !== null) parts.push(`+${tier.timeSeconds}s`);
  if (tier.extraLap) parts.push('+1 lap');
  if (tier.pointsDeduction) parts.push(`-${tier.pointsDeduction} pts`);
  for (const k of tier.nextRound) parts.push(NEXT_ROUND_LABELS[k]);
  return parts.join(' · ');
}

export const NEXT_ROUND_LABELS: Record<NextRoundPenaltyKind, string> = {
  qualifying_ban: 'Qualifying ban',
  pit_lane_start: 'Pit-lane start',
  race_ban: 'Race ban',
};
