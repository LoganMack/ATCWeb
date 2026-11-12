/**
 * The reads behind Stats > Seasons (W4; NFR1, NFR2): seasons, flagged rounds, the championship seasons' rounds
 * and events, circuits and layouts in parallel, then the race summaries of the candidate rounds in batches.
 * Only the columns the page uses are read.
 */
import { restGetAll, type SupabaseEnv } from '../db/client';
import { getAllCircuitLayouts, getCircuits } from '../db/circuits';
import { getEventWetFlagsForSeasons } from '../db/events';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getSeasons } from '../db/seasons';
import { resolveLayout } from './layouts';
import { getSeasonRaceSummaries, type SummaryScope } from './seasonRaceSummaries';
import { computeSeasonStats, type SeasonStatsRound, type SeasonStatsRow } from './seasonStats';
import { isChampionshipSeason } from './shared';

interface RoundRead extends SeasonStatsRound {
  track_name: string;
  layout: string | null;
}

const ROUND_SELECT =
  'subsession_id,season_id,start_time,track_name,layout,strength_of_field,num_drivers,event_id';

function getSeasonStatsRounds(env: SupabaseEnv, seasonIds: string[]): Promise<RoundRead[]> {
  if (seasonIds.length === 0) return Promise.resolve([]);
  const ids = seasonIds.map((id) => encodeURIComponent(id)).join(',');
  return restGetAll<RoundRead>(
    env,
    `curated_rounds?select=${ROUND_SELECT}&season_id=in.(${ids})&order=start_time.asc,subsession_id.asc`,
  );
}

/** Every Stats > Seasons row for the chosen class. Throws when a read fails, so the page shows its error. */
export async function loadSeasonStats(env: SupabaseEnv, scope: SummaryScope): Promise<SeasonStatsRow[]> {
  const seasons = (await getSeasons(env)).filter((s) => isChampionshipSeason(s.name));
  const seasonIds = seasons.map((s) => s.id);
  const [excludedRoundIds, rounds, events, circuits, layouts] = await Promise.all([
    getStandingsExcludedRoundIds(env),
    getSeasonStatsRounds(env, seasonIds),
    getEventWetFlagsForSeasons(env, seasonIds),
    getCircuits(env),
    getAllCircuitLayouts(env),
  ]);

  // The rounds read already leaves out broadcaster-hidden rounds; dropped again here because the function call
  // adds no such filter of its own (BR5.6).
  const hidden = new Set(env.hiddenSubsessionIds ?? []);
  const candidates = rounds.filter(
    (r) => !hidden.has(Number(r.subsession_id)) && !excludedRoundIds.has(Number(r.subsession_id)),
  );
  const summaries = await getSeasonRaceSummaries(
    env,
    candidates.map((r) => Number(r.subsession_id)),
  );

  const cornersByRound = new Map<number, number | null>();
  for (const round of candidates) {
    cornersByRound.set(
      Number(round.subsession_id),
      resolveLayout(round.track_name, round.layout, circuits, layouts)?.corners ?? null,
    );
  }

  return computeSeasonStats({
    seasons,
    rounds: candidates.map((r) => ({ ...r, subsession_id: Number(r.subsession_id) })),
    excludedRoundIds,
    summaries,
    events,
    cornersByRound,
    scope,
  });
}
