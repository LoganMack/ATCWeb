import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import { getAllTeamSeasonLogos } from '../db/teams';

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

/**
 * One row of `race_score_results_public`, as PostgREST returns it. The view
 * picks one set per row: the final (penalised) set for an admin or a posted
 * round, otherwise the raw set with no deduction (BR4.1, BR4.2). Pages never
 * recompute a race; they read these columns (BR1.2).
 */
export interface PublicScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  season_id: string;
  class_id: number;
  team_id: string | null;
  /** The raw finishing slot (adjusted ?? finish), DSQ'd rows included. */
  finish_position: number;
  classified: boolean;
  dsq: boolean;
  /** The raw overall position; null for a DSQ. */
  raw_position: number | null;
  shown_set: 'raw' | 'final';
  shown_position: number | null;
  shown_class_position: number | null;
  shown_laps_down: number | null;
  shown_gap_ms: number | null;
  shown_race_time_ms: number | null;
  shown_finish_points: number;
  shown_class_points: number;
  shown_finesse_bonus: number;
  shown_pole_bonus: number;
  shown_aggression_bonus: number;
  shown_lap_led_bonus: number;
  shown_fewest_incidents_bonus: number;
  shown_fastest_lap_bonus: number;
  shown_sprint_sweep_bonus: number;
  /** Always >= 0 and already subtracted from both totals. */
  shown_points_deduction: number;
  shown_overall_total: number;
  shown_class_total: number;
  shown_penalised: boolean;
  /** The raw set's class position and totals, whichever set is shown (migration 20261023120000). */
  raw_class_position: number | null;
  raw_overall_total: number;
  raw_class_total: number;
}

/** Every column of the view, in the order PublicScoreRow lists them. */
export const PUBLIC_SCORE_SELECT =
  'subsession_id,race_number,driver_id,season_id,class_id,team_id,finish_position,classified,dsq,raw_position,' +
  'shown_set,shown_position,shown_class_position,shown_laps_down,shown_gap_ms,shown_race_time_ms,' +
  'shown_finish_points,shown_class_points,shown_finesse_bonus,shown_pole_bonus,shown_aggression_bonus,' +
  'shown_lap_led_bonus,shown_fewest_incidents_bonus,shown_fastest_lap_bonus,shown_sprint_sweep_bonus,' +
  'shown_points_deduction,shown_overall_total,shown_class_total,shown_penalised,' +
  'raw_class_position,raw_overall_total,raw_class_total';

/** One driver's race as every results reader uses it: a view row with the shown_ prefix dropped. */
export interface ScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  season_id: string;
  class_id: number;
  team_id: string | null;
  classified: boolean;
  dsq: boolean;
  /** Raw finishing slot, DSQ'd rows included; orders rows that have no position. */
  finish_position: number;
  raw_position: number | null;
  set: 'raw' | 'final';
  /** Overall position in the shown set; null for a DSQ. */
  position: number | null;
  class_position: number | null;
  laps_down: number | null;
  gap_ms: number | null;
  race_time_ms: number | null;
  finish_points: number;
  class_points: number;
  finesse_bonus: number;
  pole_bonus: number;
  aggression_bonus: number;
  lap_led_bonus: number;
  fewest_incidents_bonus: number;
  fastest_lap_bonus: number;
  sprint_sweep_bonus: number;
  /** Positive; already subtracted from both totals. */
  points_deduction: number;
  /** Every bonus less the deduction, without class points (BR2.6). */
  overall_total: number;
  /** overall_total plus class points. */
  class_total: number;
  penalised: boolean;
  /** The raw set's class position and totals, before this round's penalties. */
  raw_class_position: number | null;
  raw_overall_total: number;
  raw_class_total: number;
}

export function toScoreRow(v: PublicScoreRow): ScoreRow {
  return {
    subsession_id: v.subsession_id,
    race_number: v.race_number,
    driver_id: v.driver_id,
    season_id: v.season_id,
    class_id: v.class_id,
    team_id: v.team_id,
    classified: v.classified,
    dsq: v.dsq,
    finish_position: v.finish_position,
    raw_position: v.raw_position,
    set: v.shown_set,
    position: v.shown_position,
    class_position: v.shown_class_position,
    laps_down: v.shown_laps_down,
    gap_ms: v.shown_gap_ms,
    race_time_ms: v.shown_race_time_ms,
    finish_points: v.shown_finish_points,
    class_points: v.shown_class_points,
    finesse_bonus: v.shown_finesse_bonus,
    pole_bonus: v.shown_pole_bonus,
    aggression_bonus: v.shown_aggression_bonus,
    lap_led_bonus: v.shown_lap_led_bonus,
    fewest_incidents_bonus: v.shown_fewest_incidents_bonus,
    fastest_lap_bonus: v.shown_fastest_lap_bonus,
    sprint_sweep_bonus: v.shown_sprint_sweep_bonus,
    points_deduction: v.shown_points_deduction,
    overall_total: v.shown_overall_total,
    class_total: v.shown_class_total,
    penalised: v.shown_penalised,
    raw_class_position: v.raw_class_position,
    raw_overall_total: v.raw_overall_total,
    raw_class_total: v.raw_class_total,
  };
}

/**
 * Whether a class's own championship ranks by class_total. Only the Gamma and
 * Delta class championships do; Alpha, overall, awards, hall of fame and the
 * driver page all rank by overall_total (BR2.6).
 */
export function rankedByClassTotal(className: string | undefined): boolean {
  return className === 'Gamma' || className === 'Delta';
}

/** The per-race points a class championship (or, with false, every other view) counts for this row. */
export function seasonPointsOf(row: ScoreRow, classTotal: boolean): number {
  return classTotal ? row.class_total : row.overall_total;
}

async function fetchScoreRows(env: SupabaseEnv, path: string, paged: boolean): Promise<ScoreRow[]> {
  const rows = paged
    ? await restGetAll<PublicScoreRow>(env, path)
    : await restGet<PublicScoreRow[]>(env, path);
  return rows.map(toScoreRow);
}

export interface CuratedRaceResultRow {
  subsession_id: number;
  race_number: number;
  cust_id: number;
  finish_position: number;
  starting_position: number | null;
  adjusted_position: number | null;
  incidents: number | null;
  laps_complete: number | null;
  laps_led: number | null;
  /** The car this driver used for this specific race — per-race, unlike `drivers.car` (that column is just the driver's current car). */
  car_name: string | null;
  /** Gap to the leader, in ten-thousandths of a second (iRacing's native unit) — see `formatMargin`. */
  interval_ten_thousandths: number | null;
}

export interface RoundSummary {
  subsession_id: number;
  season_id: string;
  start_time: string;
  track_name: string;
  season_label: string | null;
  /**
   * The results pipeline's own round number — NOT used for display anymore.
   * An exhibition round (round_overrides, or a whole non-championship
   * season) shouldn't shift every later round's displayed number, so the
   * app computes its own "Round N" numbering — see
   * `computeDisplayRoundNumbers`.
   */
  round_number: number | null;
  format: 'endurance' | 'sprint' | null;
  strength_of_field: number | null;
  num_drivers: number | null;
}

export interface DriverBasic {
  id: string;
  name: string;
  car_number: number | null;
  photo_url: string | null;
  iracing_cust_id: number | null;
  /** Used by the news-recap's "top 3 rookies" stat (src/lib/newsRecap.ts) — otherwise unused by anything in this file. */
  is_rookie: boolean;
  /** ISO 3166-1 alpha-2 codes (lowercase), 0029_driver_nationality.sql — see src/components/DriverFlag.astro. nationality_2 is only ever meaningful when nationality_1 is also set (dual nationality); a driver with just one nationality leaves nationality_2 null. */
  nationality_1: string | null;
  nationality_2: string | null;
  /** 0057_driver_ai_flag.sql — an AI-controlled entrant that exists only to satisfy an exhibition result's FK. See driversSelect()'s own doc comment for how this is excluded/included. */
  is_ai: boolean;
}

/**
 * Exported so a caller needing MULTIPLE standings views for one season (e.g.
 * the homepage's standings widget) can fetch this once and pass it as
 * `driversBasic` to each call, same sharing reasoning as
 * `getSeasonOverallContext`.
 *
 * `includeAi` (default false) excludes AI-flagged drivers (0057_driver_ai_flag.sql)
 * from the returned driver map. That's correct for every standings/champions/
 * career-stats/team-stats consumer of this function — an AI driver only ever
 * appears in an exhibition round, which those computations already exclude
 * from counted results, so leaving them out of the driver map costs nothing
 * there. `getRoundResults()` and `getQualifyingForSubsession()` are the two
 * exceptions: they pass `{ includeAi: true }` because a round-results page
 * needs to resolve an AI driver's race_score_results row to a REAL driver, not let
 * it fall through to the synthetic "not in roster" path (see toUnrosteredRow) —
 * the entire reason an AI driver's row exists is to appear correctly on the
 * one exhibition round it raced in.
 */
export function driversSelect(env: SupabaseEnv, { includeAi = false }: { includeAi?: boolean } = {}) {
  const aiFilter = includeAi ? '' : '&is_ai=eq.false';
  return restGet<DriverBasic[]>(
    env,
    `drivers?select=id,name,car_number,photo_url,iracing_cust_id,is_rookie,nationality_1,nationality_2,is_ai${aiFilter}`,
  );
}

export function getRaceScoresForSeasonClass(env: SupabaseEnv, seasonId: string, classId: number) {
  return fetchScoreRows(
    env,
    `race_score_results_public?select=${PUBLIC_SCORE_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}`,
    false,
  );
}

/**
 * Every class's rows for EVERY given season, in one query — the
 * multi-season equivalent of `getRaceScoresForSeasonClass` +
 * `getRaceScoresForSeasonOverall`. Exists for the bulk career, champions and
 * awards computations, which need every championship season at once;
 * calling the single-season queries per season ran past Cloudflare Workers'
 * per-request subrequest limit.
 */
export function getRaceScoresForSeasonsBulk(env: SupabaseEnv, seasonIds: string[]) {
  if (seasonIds.length === 0) return Promise.resolve([] as ScoreRow[]);
  // Paged, and in a stable unique order so no row is skipped or repeated
  // between pages: this is the biggest result set in the app.
  return fetchScoreRows(
    env,
    `race_score_results_public?select=${PUBLIC_SCORE_SELECT}&season_id=in.(${seasonIds.map((id) => encodeURIComponent(id)).join(',')})&order=subsession_id.asc,race_number.asc,driver_id.asc`,
    true,
  );
}

/** Every class combined — see `computeOverallSeasonStandings` and `getSeasonCarTeamStats`. */
export function getRaceScoresForSeasonOverall(env: SupabaseEnv, seasonId: string) {
  return fetchScoreRows(
    env,
    `race_score_results_public?select=${PUBLIC_SCORE_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`,
    false,
  );
}

/** One round's rows, every class. */
export function getRaceScoresForSubsession(env: SupabaseEnv, subsessionId: number) {
  return fetchScoreRows(
    env,
    `race_score_results_public?select=${PUBLIC_SCORE_SELECT}&subsession_id=eq.${subsessionId}`,
    false,
  );
}

export interface CuratedQualifyingBulkRow {
  subsession_id: number;
  cust_id: number;
  qual_position: number | null;
}

/**
 * Bulk qualifying positions across many subsessions — same restGetAll
 * reasoning as getCuratedRaceResultsForSubsessions below. Backs
 * getDriverRaceHistory's "Avg Qualify" split stat. Only race_number 1 of
 * each round has REAL qualifying (race 2/3 invert off it — see
 * computeOverallSeasonStandings' own "only race with real qualifying"
 * comment), so callers should only attribute a subsession's row here to
 * that round's race-1 DriverRaceHistoryRow, never to race 2/3.
 */
export function getQualifyingForSubsessionsBulk(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as CuratedQualifyingBulkRow[]);
  return restGetAll<CuratedQualifyingBulkRow>(
    env,
    `curated_qualifying?select=subsession_id,cust_id,qual_position&subsession_id=in.(${subsessionIds.join(',')})`,
  );
}

export function getCuratedRaceResultsForSubsessions(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as CuratedRaceResultRow[]);
  // Deliberately does NOT select best_lap_ten_thousandths (fastest-lap data,
  // needed only by the news recap's "fastest lap" stat — see
  // src/lib/newsRecap.ts) even though that column exists on this same
  // table: PostgREST fails the ENTIRE query if any selected column doesn't
  // exist (see this file's header), and this function backs every results/
  // standings/champions page in the app. Keeping that one column's fetch
  // isolated to its own small query in newsRecap.ts means a typo'd or
  // renamed column there can only ever degrade the recap, never take down
  // the rest of the site.
  const select =
    'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,laps_led,car_name,interval_ten_thousandths';
  // restGetAll — see getPenaltiesForSubsessions' identical reasoning; a
  // whole-career query can span hundreds of rounds, well past Supabase's
  // default 1000-row response cap. Explicit order (unique per row, same
  // reasoning as getRaceScoresForSeasonsBulk) keeps a paginated fetch
  // stable across requests.
  return restGetAll<CuratedRaceResultRow>(
    env,
    `curated_race_results?select=${select}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
  );
}

export interface RawLapStatsRow {
  subsession_id: number;
  race_number: number;
  cust_id: number;
  /** iRacing's own per-driver average lap for the race, ten-thousandths of a second — NOT selected by getCuratedRaceResultsForSubsessions above (see that function's comment on why an unverified column stays isolated). Source for "overall race time" (own laps × own average lap — the same manual method Logan already used for penalty math on laps-down drivers, rule 18.3.2) and for the results page's average-lap stat. */
  average_lap_ten_thousandths: number | null;
  /** Same isolation reasoning — this driver's single fastest lap the race, ten-thousandths of a second. Already read this same way (its own tiny query) for the news recap's fastest-lap stat (see newsRecap.ts's fetchBestLaps) — pulled here too since results/standings rows now show it per driver, not just the round-wide fastest lap. */
  best_lap_ten_thousandths: number | null;
}

/**
 * Isolated, try/catch-wrapped fetch of two `curated_race_results` columns
 * this file's SHARED query (getCuratedRaceResultsForSubsessions)
 * deliberately doesn't select — same reasoning as that function's own
 * comment: PostgREST fails an entire query if any one selected column
 * doesn't exist, and this file backs every results/standings/champions
 * page, so an unverified column can only be allowed to degrade its OWN
 * feature, never take down the rest of the site. On failure, every caller
 * below just proceeds without average/best lap data — average-lap-based
 * penalty ranking (rule 18.3.2, see reorderByTimePenalty in
 * src/lib/penalties.ts) falls back to its pre-existing, narrower
 * interval-only behavior, and the results page simply omits the
 * average/best lap stats.
 */
export async function getLapStatsForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<RawLapStatsRow[]> {
  if (subsessionIds.length === 0) return [];
  try {
    // restGetAll — same reasoning (and same explicit order, for the same
    // paginated-stability reason) as getCuratedRaceResultsForSubsessions.
    return await restGetAll<RawLapStatsRow>(
      env,
      `curated_race_results?select=subsession_id,race_number,cust_id,average_lap_ten_thousandths,best_lap_ten_thousandths&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
    );
  } catch (err) {
    console.error(
      'Failed to fetch average/best lap data (curated_race_results.average_lap_ten_thousandths) — falling back to interval-only penalty ranking and omitting lap-time stats:',
      err,
    );
    return [];
  }
}

interface RawDisplayNameRow {
  subsession_id: number;
  race_number: number;
  cust_id: number;
  /** NOT NULL on the underlying table (see raceResultsImport.ts's own note on this column) — the results pipeline's own name for this cust_id, independent of this app's `drivers.name`. Only ever needed for an entrant who raced but has no matching `drivers` row at all (see toUnrosteredRow in getRoundResults) — every other reader already has a real `drivers` row to get a name from instead, hence isolating this one column the same way average/best lap above are isolated. */
  display_name: string;
}

/**
 * Same isolation reasoning as getLapStatsForSubsessions right above —
 * display_name isn't selected by the shared getCuratedRaceResultsForSubsessions
 * query, so a schema hiccup on this one column degrades only the "show an
 * unrostered entrant's real name" feature (getRoundResults falls back to
 * "Cust #<id>" per row when this comes back empty) rather than taking down
 * every page that shares that query.
 */
export async function getDisplayNamesForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<RawDisplayNameRow[]> {
  if (subsessionIds.length === 0) return [];
  try {
    return await restGetAll<RawDisplayNameRow>(
      env,
      `curated_race_results?select=subsession_id,race_number,cust_id,display_name&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
    );
  } catch (err) {
    console.error(
      'Failed to fetch display_name (curated_race_results.display_name) — unrostered entrants will show as "Cust #<id>" instead of their real name:',
      err,
    );
    return [];
  }
}

export interface TeamBasic {
  id: string;
  name: string;
  logo_url: string | null;
}

/** Lean team lookup (id/name/logo only) for showing the team a driver raced for on a given race_score_results row — see `RaceResultRow.team`. Exported (like `driversSelect`) so a caller needing several team-scoped views at once — the homepage standings widget's Alpha/Delta team tabs — can fetch this once and share it via `teamsBasic`, instead of each tab re-fetching it. */
export function getTeamsBasic(env: SupabaseEnv) {
  return restGet<TeamBasic[]>(env, 'teams?select=id,name,logo_url');
}

function teamSeasonLogoKey(teamId: string, seasonId: string): string {
  return `${teamId}:${seasonId}`;
}

/** team_id:season_id -> logo_url, built once per call site that needs season-aware team logos (getRoundResults, getSeasonCarTeamStats) — see 0019_team_season_logos.sql. */
export function buildSeasonLogoMap(
  rows: { team_id: string; season_id: string; logo_url: string }[],
): Map<string, string> {
  return new Map(rows.map((r) => [teamSeasonLogoKey(r.team_id, r.season_id), r.logo_url]));
}

/**
 * getAllTeamSeasonLogos(), wrapped in its own try/catch. This function is
 * now called from getRoundResults() and getSeasonCarTeamStats() — the
 * shared plumbing behind EVERY results/standings/news-recap page — so
 * unlike most queries in this file, it can't be allowed to fail the whole
 * Promise.all it's part of. Until 0019_team_season_logos.sql has actually
 * been run against the live database, this just means every team shows its
 * current logo everywhere (the same behavior as before this feature
 * existed) instead of every one of those pages throwing.
 *
 * Exported for the same sharing reason as `getTeamsBasic` just above — the
 * homepage standings widget's two team tabs can fetch this once and pass it
 * into both `computeTeamSeasonStandings` calls via `seasonLogoRowsParam`.
 */
export async function getAllTeamSeasonLogosSafe(env: SupabaseEnv): ReturnType<typeof getAllTeamSeasonLogos> {
  try {
    return await getAllTeamSeasonLogos(env);
  } catch (err) {
    console.error(
      'Failed to fetch team_season_logos (migration 0019 not applied yet?) — falling back to current team logos only:',
      err,
    );
    return [];
  }
}

/**
 * A team's logo AS OF a specific season — the season's historical override
 * if one's been uploaded (0019_team_season_logos.sql), otherwise the
 * team's current logo. `seasonId` is null when the caller couldn't
 * determine a season for what it's showing (falls straight back to the
 * current logo).
 */
export function resolveTeamLogo(
  team: TeamBasic,
  seasonId: string | null,
  seasonLogos: Map<string, string>,
): string | null {
  if (seasonId) {
    const override = seasonLogos.get(teamSeasonLogoKey(team.id, seasonId));
    if (override) return override;
  }
  return team.logo_url;
}

export function resultKey(subsessionId: number, raceNumber: number, custId: number) {
  return `${subsessionId}:${raceNumber}:${custId}`;
}
