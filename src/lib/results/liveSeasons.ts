/**
 * The live path for several seasons at once: the fallback for seasons whose stored round stats are
 * incomplete (src/lib/results/roundStatsAdapter.ts). Every ingredient is read once for all of them and
 * sliced per season in memory, as the bulk career and champions computations always did, so the Workers
 * subrequest limit holds.
 */
import type { SupabaseEnv } from '../db/client';
import type { Season } from '../db/seasons';
import { getPenaltiesForSubsessions } from '../db/penalties';
import { getRaceScoresForSeasonsBulk, type DriverBasic, type ScoreRow } from './rows';
import { buildSeasonOverallContext, type SeasonOverallContext } from './seasonContext';
import { getAllRounds } from './rounds';
import { getCuratedRaceResultsWithLapStatsBulk } from './extendedStats';
import { getRoundLayoutsForSubsessions } from './layoutLaps';

/** One season's live inputs: its score rows (every class) and the context built from them. */
export interface LiveSeasonInputs {
  scores: ScoreRow[];
  context: SeasonOverallContext;
}

/**
 * Score rows, raw results, lap stats, penalties and rounds for these seasons, as one context per season with
 * score rows. `withRoundLayouts` also reads curated_rounds.layout, for the km and corners stats.
 */
export async function loadLiveSeasonInputs(
  env: SupabaseEnv,
  seasons: Season[],
  drivers: DriverBasic[],
  exhibitionIds: Set<number>,
  { withRoundLayouts = false }: { withRoundLayouts?: boolean } = {},
): Promise<{ bySeasonId: Map<string, LiveSeasonInputs>; roundLayouts: Map<number, string | null> }> {
  if (seasons.length === 0) return { bySeasonId: new Map(), roundLayouts: new Map() };
  const [bulkScores, allRounds] = await Promise.all([
    getRaceScoresForSeasonsBulk(
      env,
      seasons.map((s) => s.id),
    ),
    getAllRounds(env),
  ]);
  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties, roundLayouts] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
    withRoundLayouts
      ? getRoundLayoutsForSubsessions(env, allSubsessionIds)
      : Promise.resolve(new Map<number, string | null>()),
  ]);

  const bySeasonId = new Map<string, LiveSeasonInputs>();
  for (const season of seasons) {
    const scores = bulkScores.filter((s) => s.season_id === season.id);
    if (scores.length === 0) continue;
    const ids = new Set(scores.map((s) => s.subsession_id));
    bySeasonId.set(season.id, {
      scores,
      context: buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        scores,
        rawResults.filter((r) => ids.has(r.subsession_id)),
        penalties.filter((p) => ids.has(p.subsession_id)),
        allRounds.filter((r) => r.season_id === season.id),
        lapStats.filter((r) => ids.has(r.subsession_id)),
      ),
    });
  }
  return { bySeasonId, roundLayouts };
}
