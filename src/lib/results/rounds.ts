import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import type { EventRecord } from '../db/events';
import { isChampionshipSeason } from './shared';
import type { RoundSummary } from './rows';

// ---------------------------------------------------------------------------
// Race results — browsing rounds and their race-by-race results
// ---------------------------------------------------------------------------

const ROUND_SUMMARY_SELECT =
  'subsession_id,season_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers';

/** Every round for a season, most recent first. */
export function getRoundsForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&order=start_time.desc`,
  );
}

/** Every round across every season, most recent first — powers the "link to a round" picker on the news post editor (src/pages/admin/news/*), which needs to search/pick across all of history rather than one season at a time. One query rather than N getRoundsForSeason() calls, since a per-season loop would be exactly the kind of N+1 this file's header already warns against on pages that list many seasons at once. */
export function getAllRounds(env: SupabaseEnv) {
  // restGetAll — this app now has enough seasons/rounds on file (and
  // computeDriverCareerStats reuses this exact function for its own
  // whole-history fetch) that a plain restGet risks silently truncating at
  // Supabase's default 1000-row response cap instead of erroring. See
  // restGetAll's own doc comment.
  return restGetAll<RoundSummary>(env, `curated_rounds?select=${ROUND_SUMMARY_SELECT}&order=start_time.desc`);
}

/**
 * Just the start_time of every officially-scored round — the minimal slice
 * of curated_rounds needed to count "rounds since date X" the same way
 * sync_driver_statuses() does for its never-raced-driver Inactive check
 * (0063_driver_never_raced_inactivity.sql's `curated_rounds.status =
 * 'official'` branch). Paired with supabase.ts's roundsSinceDate() to power
 * the "X/12 rounds absent" half of a New driver's inactivity tooltip
 * (buildInactivityNote) on the roster, driver profile, and admin drivers
 * pages.
 *
 * Deliberately NOT the same source as isOnProbationNow()'s own "rounds
 * since date X" clock (src/lib/penalties.ts), which counts calendar events
 * instead — that's an intentional difference for probation (a driver can't
 * outlast probation just because results haven't been imported yet), but
 * the inactivity rule's own DB-side automation only ever looks at real,
 * officially-scored rounds, so this display has to match that or it'll
 * claim a driver has "fulfilled the requirements" to go Inactive before the
 * database actually agrees and flips them.
 */
export function getOfficialRoundStartTimes(env: SupabaseEnv) {
  return restGetAll<{ start_time: string }>(
    env,
    `curated_rounds?select=start_time&status=eq.official&order=start_time.asc`,
  );
}

export async function getRoundBySubsessionId(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<RoundSummary | null> {
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&subsession_id=eq.${subsessionId}`,
  );
  return rounds[0] ?? null;
}

/** Just the newest round on file (by start_time) — powers the homepage's "Previous Result" card. A dedicated `limit=1` query rather than getAllRounds()[0]; no reason to pull the whole table's history down to the edge function just to look at the first row. */
export async function getMostRecentRound(env: SupabaseEnv): Promise<RoundSummary | null> {
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&order=start_time.desc&limit=1`,
  );
  return rounds[0] ?? null;
}

/**
 * Resolves an admin-scheduled Event to whichever curated_rounds row (real or
 * manually-imported) represents it, if any exists yet — live, with no stored
 * link (see events.season_id/round_number/subsession_id's own comments in
 * 0035_events_rounds_categories.sql). Two resolution paths, tried in the
 * order the migration's column comments prefer:
 *
 * 1. season_id + round_number auto-matching — curated_rounds.round_number's
 *    OWN numbering (set by the real iRacing pipeline), not the site's
 *    computed-for-display "Round N" (see computeDisplayRoundNumbers below —
 *    a different number entirely). Only populated for real pipeline
 *    imports; the manual CSV importer always leaves it null, which is fine
 *    since TEST/EXHIBITION events (what that importer's rounds tend to back)
 *    are season-agnostic and don't use this path anyway.
 * 2. subsession_id — the manual admin override/pin, used as a fallback when
 *    auto-matching isn't applicable (season-agnostic events, with no
 *    round_number to match on) or found nothing (auto-matching applies in
 *    principle but no matching round has been imported yet).
 */
export async function getEventRound(env: SupabaseEnv, event: EventRecord): Promise<RoundSummary | null> {
  if (event.season_id && event.round_number != null) {
    const rounds = await getRoundsForSeason(env, event.season_id);
    const match = rounds.find((r) => r.round_number === event.round_number);
    if (match) return match;
  }
  if (event.subsession_id != null) {
    return getRoundBySubsessionId(env, event.subsession_id);
  }
  return null;
}

/**
 * Recomputes each round's displayed "Round N" number, chronological within
 * the season, skipping any round that's an exhibition or a test session —
 * either flagged individually (`round_overrides`) or, for exhibitions only,
 * because the whole season isn't a real championship (see
 * `isChampionshipSeason` — a test-flagged round is always inside an
 * otherwise-real season, there's no such thing as a whole "test season").
 * Per Logan: flagging round 1 as an exhibition (or a test) should make round
 * 2 become "Round 1", not leave a gap — Test Sessions follow the exact same
 * rule Exhibitions already did. Returns null for an excluded round; the UI
 * shows "Exhibition"/"Test" instead of "Round N" for those.
 */
export function computeDisplayRoundNumbers(
  rounds: RoundSummary[],
  exhibitionRoundIds: Set<number>,
  testRoundIds: Set<number>,
): Map<number, number | null> {
  const chronological = [...rounds].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
  );
  const out = new Map<number, number | null>();
  let counter = 0;
  for (const r of chronological) {
    const excluded =
      exhibitionRoundIds.has(r.subsession_id) ||
      testRoundIds.has(r.subsession_id) ||
      (r.season_label ? !isChampionshipSeason(r.season_label) : false);
    out.set(r.subsession_id, excluded ? null : ++counter);
  }
  return out;
}
