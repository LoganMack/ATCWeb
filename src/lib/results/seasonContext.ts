import type { SupabaseEnv } from '../db/client';
import { getSeasons, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions, type Penalty } from '../db/penalties';
import {
  getRaceScoresForSeasonOverall,
  getCuratedRaceResultsForSubsessions,
  getLapStatsForSubsessions,
  resultKey,
  type CuratedRaceResultRow,
  type ScoreRow,
  type RawLapStatsRow,
  type RoundSummary,
  type DriverBasic,
} from './rows';
import { getRoundsForSeason } from './rounds';

// ---------------------------------------------------------------------------
// Season-wide context — the rows computeSeasonStandings,
// computeOverallSeasonStandings and the other season views share, fetched
// once per season.
// ---------------------------------------------------------------------------

export interface CurrentSeasonRounds {
  season: Season | null;
  subsessionIds: number[];
  formatBySubsession: Map<number, RoundSummary['format']>;
}

/**
 * The `is_current` season's round subsession_ids: what "this season" means for PP and warnings (rule 57),
 * whatever season a page shows. Empty when no season is current.
 */
export async function getCurrentSeasonRounds(env: SupabaseEnv): Promise<CurrentSeasonRounds> {
  const seasons = await getSeasons(env);
  const season = seasons.find((s) => s.is_current) ?? null;
  if (!season) return { season: null, subsessionIds: [], formatBySubsession: new Map() };
  const rounds = await getRoundsForSeason(env, season.id);
  return {
    season,
    subsessionIds: rounds.map((r) => r.subsession_id),
    formatBySubsession: new Map(rounds.map((r) => [r.subsession_id, r.format])),
  };
}

export interface SeasonOverallContext {
  /** This season's penalties, for the standings Matrix's per-round penalty summaries. Points and positions already include them (race_score_results_public). */
  penalties: Penalty[];
  formatBySubsession: Map<number, RoundSummary['format']>;
  rawByKey: Map<string, CuratedRaceResultRow>;
  overallScores: ScoreRow[];
  custIdByDriverId: Map<string, number>;
  /** (subsessionId:raceNumber:custId) -> that result's average/best lap data. */
  lapStatsByKey: Map<string, RawLapStatsRow>;
  /** This season's own `curated_rounds` rows (the same fetch `formatBySubsession` is derived from) — exposed so a caller that also needs another field off these rows (e.g. `getSeasonDriverExtendedStats`' track_name lookup for distance/corners) can reuse this instead of re-querying `curated_rounds` a second time for the same season. */
  seasonRounds: RoundSummary[];
}

/**
 * Fetches the rows every standings view shares (scores from race_score_results_public, raw results, lap
 * stats, penalties, rounds); positions and points come from the view, so nothing is recomputed. Exported so a
 * page showing several views of one season builds it once; bulk callers use buildSeasonOverallContext on
 * slices instead.
 */
export async function getSeasonOverallContext(
  env: SupabaseEnv,
  season: Season,
  exhibitionIds: Set<number>,
  drivers: DriverBasic[],
): Promise<SeasonOverallContext> {
  const overallScoresRaw = await getRaceScoresForSeasonOverall(env, season.id);
  // Fetch only for the rounds the context keeps; buildSeasonOverallContext
  // applies the same filter to the scores themselves.
  const filteredForFetchScope =
    exhibitionIds.size > 0
      ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id))
      : overallScoresRaw;
  const subsessionIds = [...new Set(filteredForFetchScope.map((s) => s.subsession_id))];
  const [rawResults, penalties, seasonRounds, lapStats] = await Promise.all([
    getCuratedRaceResultsForSubsessions(env, subsessionIds),
    getPenaltiesForSubsessions(env, subsessionIds),
    getRoundsForSeason(env, season.id),
    getLapStatsForSubsessions(env, subsessionIds),
  ]);

  return buildSeasonOverallContext(
    exhibitionIds,
    drivers,
    overallScoresRaw,
    rawResults,
    penalties,
    seasonRounds,
    lapStats,
  );
}

/**
 * Pure (no network) half of `getSeasonOverallContext`, taking the same raw
 * ingredients as plain arrays. `getSeasonOverallContext` calls this right
 * after its one-season fetch; the bulk career, champions and awards
 * computations call it once per season on slices of one multi-season fetch.
 */
export function buildSeasonOverallContext(
  exhibitionIds: Set<number>,
  drivers: DriverBasic[],
  overallScoresRaw: ScoreRow[],
  rawResults: CuratedRaceResultRow[],
  penalties: Penalty[],
  seasonRounds: RoundSummary[],
  lapStats: RawLapStatsRow[],
): SeasonOverallContext {
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );

  const overallScores =
    exhibitionIds.size > 0
      ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id))
      : overallScoresRaw;

  if (overallScores.length === 0) {
    return {
      penalties: [],
      formatBySubsession: new Map(),
      rawByKey: new Map(),
      overallScores: [],
      custIdByDriverId,
      lapStatsByKey: new Map(),
      seasonRounds: [],
    };
  }

  return {
    penalties,
    formatBySubsession: new Map(seasonRounds.map((r) => [r.subsession_id, r.format])),
    rawByKey: new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r])),
    overallScores,
    custIdByDriverId,
    lapStatsByKey: new Map(lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r])),
    seasonRounds,
  };
}
