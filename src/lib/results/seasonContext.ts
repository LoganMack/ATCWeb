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
 * The site's one `is_current` season's round subsession_ids — this is what
 * "this season" means for PP/warning scoping (rule 57's season PP limit),
 * as opposed to the arbitrary season a standings/champions page might be
 * showing. Returns an empty result (no rounds) if no season is currently
 * flagged current.
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
 * Fetches the season-wide rows every standings view shares: every class's
 * scores (race_score_results_public), the raw results, lap stats, penalties
 * and rounds. Positions and points come straight from the view, so a
 * penalty logged on the incident page reaches both standings views without
 * any recompute here.
 *
 * A thin fetch-then-build wrapper around `buildSeasonOverallContext` below —
 * every single-season caller (Standings, Team Standings, Champions, Race
 * Results) goes through this one-season-at-a-time fetch. `computeDriverCareerStats`,
 * which needs this same context for MANY seasons at once, instead
 * bulk-fetches the same raw ingredients ONCE across every season and
 * calls `buildSeasonOverallContext` directly per season on its own
 * in-memory slice, with no network calls in that loop.
 *
 * Exported so any caller that needs MULTIPLE standings views for the same
 * season — e.g. the homepage's Overall/Alpha/Gamma/Delta/Rookies standings
 * widget — can build this once and pass it as `precomputedOverallContext`
 * to each of computeSeasonStandings/computeOverallSeasonStandings, instead
 * of each view re-fetching its own copy.
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
