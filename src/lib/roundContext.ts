/**
 * Round labels for lists that span rounds (kudos and interviews): "ATC17, Round 4", the track and the date,
 * numbered the way History > Incidents numbers rounds (per season, exhibition and test rounds unnumbered).
 * Two reads: the rounds and the standings-excluded round ids.
 */
import type { SupabaseEnv } from './db/client';
import { getStandingsExcludedRoundIds } from './db/rounds';
import { computeDisplayRoundNumbers, getAllRounds, getRoundsForSeason } from './results/rounds';
import type { RoundSummary } from './results/rows';
import { seasonRoundLabel } from './roundLabels';

export interface RoundContext {
  subsessionId: number;
  seasonLabel: string | null;
  displayRoundNumber: number | null;
  /** "ATC17, Round 4" or "ATC17, Exhibition". */
  label: string;
  trackName: string;
  startTime: string;
}

/** Each round's context, numbered within its own season. */
export function buildRoundContexts(
  rounds: RoundSummary[],
  excludedRoundIds: Set<number>,
): Map<number, RoundContext> {
  const bySeason = new Map<string, RoundSummary[]>();
  for (const r of rounds) {
    const key = r.season_id ?? r.season_label ?? '';
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key)!.push(r);
  }
  const out = new Map<number, RoundContext>();
  for (const seasonRounds of bySeason.values()) {
    const numbers = computeDisplayRoundNumbers(seasonRounds, excludedRoundIds, new Set());
    for (const r of seasonRounds) {
      const displayRoundNumber = numbers.get(r.subsession_id) ?? null;
      out.set(r.subsession_id, {
        subsessionId: r.subsession_id,
        seasonLabel: r.season_label,
        displayRoundNumber,
        label: seasonRoundLabel(r.season_label, displayRoundNumber),
        trackName: r.track_name,
        startTime: r.start_time,
      });
    }
  }
  return out;
}

/** One season's rounds (a History page's filter), or every round (a driver's kudos across seasons). */
export async function getRoundContexts(
  env: SupabaseEnv,
  seasonId?: string,
): Promise<Map<number, RoundContext>> {
  const [rounds, excluded] = await Promise.all([
    seasonId ? getRoundsForSeason(env, seasonId) : getAllRounds(env),
    getStandingsExcludedRoundIds(env),
  ]);
  return buildRoundContexts(rounds, excluded);
}
