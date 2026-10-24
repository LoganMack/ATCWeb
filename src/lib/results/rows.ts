import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import { getAllTeamSeasonLogos } from '../db/teams';
import { memoized } from '../requestMemo';

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
   * The pipeline's own round number, not used for display: exhibitions mustn't shift later rounds, so the app
   * numbers rounds itself (computeDisplayRoundNumbers).
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
  /** drivers_shown (U4): the name reads "Hidden Driver"; render no profile link or photo (src/lib/privacy.ts). */
  is_hidden?: boolean;
}

/**
 * Exported so a caller needing several standings views can fetch it once. AI-flagged drivers (0057) are left
 * out by default, since they only race exhibitions; the round-results and qualifying pages pass `includeAi`
 * so an AI row resolves to its driver instead of the "not in roster" path.
 */
export function driversSelect(env: SupabaseEnv, { includeAi = false }: { includeAi?: boolean } = {}) {
  const aiFilter = includeAi ? '' : '&is_ai=eq.false';
  // The masked view (U4): a hidden driver reads "Hidden Driver" with no photo and a stand-in customer id,
  // the same one the *_shown results views carry, so the cust_id joins below still pair rows up.
  return memoized(env, 'driversSelect', [includeAi], () =>
    restGet<DriverBasic[]>(
      env,
      `drivers_shown?select=id,name,car_number,photo_url,iracing_cust_id,is_rookie,nationality_1,nationality_2,is_ai,is_hidden${aiFilter}`,
    ),
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
 * Every class's rows for many seasons in one query, for the bulk career, champions and awards computations;
 * per-season queries exceed the Workers subrequest limit.
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
 * Bulk qualifying positions for the driver page's "Avg Qualify". Only race 1 has real qualifying (races 2/3
 * invert off it), so attribute a row to the round's race 1 only.
 */
export function getQualifyingForSubsessionsBulk(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as CuratedQualifyingBulkRow[]);
  return restGetAll<CuratedQualifyingBulkRow>(
    env,
    `curated_qualifying_shown?select=subsession_id,cust_id,qual_position&subsession_id=in.(${subsessionIds.join(',')})`,
  );
}

export function getCuratedRaceResultsForSubsessions(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as CuratedRaceResultRow[]);
  // best_lap_ten_thousandths stays out: PostgREST fails the whole query on a missing column and this query
  // backs every results page, so that column is fetched in its own query (newsRecap.ts).
  const select =
    'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,laps_led,car_name,interval_ten_thousandths';
  // restGetAll: a whole-career query can pass Supabase's 1000-row cap. The unique order keeps pagination
  // stable.
  return restGetAll<CuratedRaceResultRow>(
    env,
    `curated_race_results_shown?select=${select}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
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
 * Two curated_race_results columns fetched apart from the shared query, so an unverified column only degrades
 * its own feature. On failure callers carry on without average/best laps and the results page omits them.
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
      `curated_race_results_shown?select=subsession_id,race_number,cust_id,average_lap_ten_thousandths,best_lap_ten_thousandths&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
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
 * display_name, isolated like getLapStatsForSubsessions; on failure unrostered entrants show "Cust #<id>".
 */
export async function getDisplayNamesForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<RawDisplayNameRow[]> {
  if (subsessionIds.length === 0) return [];
  try {
    return await restGetAll<RawDisplayNameRow>(
      env,
      `curated_race_results_shown?select=subsession_id,race_number,cust_id,display_name&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
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
  return memoized(env, 'getTeamsBasic', [], () => restGet<TeamBasic[]>(env, 'teams?select=id,name,logo_url'));
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
 * getAllTeamSeasonLogos() that never throws: it backs every results, standings and recap page, so on failure
 * teams just show their current logo. Exported so the homepage's two team tabs can share one fetch.
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
