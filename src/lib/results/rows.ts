import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import { getAllTeamSeasonLogos } from '../db/teams';

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

export interface RaceScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  /** Only needed by computeTeamSeasonStandings' per-class path (e.g. Delta's own team competition) — every other consumer of this row shape ignores it. */
  team_id: string | null;
  total_points: number;
  class_points: number;
  finesse_bonus: number;
  points_deduction: number;
  pole_bonus: number;
  /** "Naked Aggression" bonus (0033_naked_aggression_bonus.sql) — folded into total_points same as every other bonus component; every reader that backs out finish_points from total_points, or recomputes it on a penalty, needs this. */
  aggression_bonus: number;
  /** Four new per-class/per-race bonuses (0067_ruleset_overhaul_and_bonuses.sql) — same "folded into total_points" reasoning as aggression_bonus above. */
  lap_led_bonus: number;
  fewest_incidents_bonus: number;
  fastest_lap_bonus: number;
  sprint_sweep_bonus: number;
  classified: boolean;
  dsq: boolean;
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
 * needs to resolve an AI driver's race_scores row to a REAL driver, not let
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
  const select =
    'subsession_id,race_number,driver_id,team_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,aggression_bonus,lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,classified,dsq';
  return restGet<RaceScoreRow[]>(
    env,
    `race_scores_public?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}`,
  );
}

/**
 * Every field either `RaceScoreRow` (the per-class shape) or
 * `RaceScoreOverallRow` (the cross-class shape) ever needs, off the same
 * underlying `race_scores` table, plus `season_id` so a caller who fetched
 * rows for MANY seasons at once can group them back out by season
 * afterward. A value of this shape is structurally assignable anywhere a
 * `RaceScoreRow[]` or `RaceScoreOverallRow[]` is expected (it's a strict
 * superset of both), so `computeDriverCareerStats` can feed one bulk fetch
 * straight into both computations without converting anything.
 */
interface RaceScoreBulkRow extends RaceScoreRow, RaceScoreOverallRowFields {
  season_id: string;
}
interface RaceScoreOverallRowFields {
  class_id: number;
  finish_points: number;
  scored_position: number | null;
}

/**
 * Every class's `race_scores` rows for EVERY given season, in one query —
 * the multi-season equivalent of `getRaceScoresForSeasonClass` +
 * `getRaceScoresForSeasonOverall` combined. Exists for
 * `computeDriverCareerStats`, which needs this data for every championship
 * season on file; calling either of those once per class per season (or
 * even once per season) was the actual remaining cause of that function's
 * subrequest-count problem even after its first optimization pass — see
 * that function's own doc comment. Every other/older caller still uses the
 * single-season queries above, unaffected.
 */
export function getRaceScoresForSeasonsBulk(env: SupabaseEnv, seasonIds: string[]) {
  if (seasonIds.length === 0) return Promise.resolve([] as RaceScoreBulkRow[]);
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,season_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,aggression_bonus,lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,classified,dsq,finish_points,scored_position';
  // restGetAll, not restGet — this is easily the biggest single result set
  // in the app (every class, every race, every driver, every championship
  // season at once) and can run well past Supabase's default 1000-row
  // response cap. See restGetAll's own doc comment.
  // A stable order (subsession_id/race_number/driver_id together are
  // unique per row) matters once a query is paginated across several
  // requests — an unordered result set's row order isn't guaranteed
  // consistent between separate requests, which could skip or duplicate
  // rows across pages.
  return restGetAll<RaceScoreBulkRow>(
    env,
    `race_scores_public?select=${select}&season_id=in.(${seasonIds.map((id) => encodeURIComponent(id)).join(',')})&order=subsession_id.asc,race_number.asc,driver_id.asc`,
  );
}

export interface RaceScoreOverallRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  team_id: string | null;
  finish_points: number;
  finesse_bonus: number;
  pole_bonus: number;
  points_deduction: number;
  /** "Naked Aggression" bonus (0033_naked_aggression_bonus.sql) — see RaceScoreRow's identical field for why every points-recompute path needs this. */
  aggression_bonus: number;
  dsq: boolean;
  classified: boolean;
  scored_position: number | null;
}

/** Every class combined — see `computeOverallSeasonStandings` and `getSeasonCarTeamStats`. */
export function getRaceScoresForSeasonOverall(env: SupabaseEnv, seasonId: string) {
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,finish_points,finesse_bonus,pole_bonus,points_deduction,aggression_bonus,dsq,classified,scored_position';
  return restGet<RaceScoreOverallRow[]>(
    env,
    `race_scores_public?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

/**
 * Same shape as `getRaceScoresForSeasonOverall` (every class, every driver),
 * but scoped by explicit subsession_ids instead of one season — for
 * `getDriverRaceHistory`, which spans one driver's WHOLE CAREER (many
 * seasons at once, not one at a time). computeSeasonOverallAdjustments'
 * time-penalty reorder needs a race's WHOLE field (every driver, not just
 * the one this page is about) to correctly cascade who moves where — see
 * src/lib/penalties.ts's reorderByTimePenalty — so a single driver's own
 * race_scores rows alone aren't enough to recompute their own position.
 * restGetAll, not restGet — a career spanning many rounds times every OTHER
 * driver in each one easily clears Supabase's default 1000-row cap.
 */
export function getRaceScoresForSubsessionsOverall(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as RaceScoreOverallRow[]);
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,finish_points,finesse_bonus,pole_bonus,points_deduction,aggression_bonus,dsq,classified,scored_position';
  return restGetAll<RaceScoreOverallRow>(
    env,
    `race_scores_public?select=${select}&subsession_id=in.(${subsessionIds.join(',')})`,
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

/** Lean team lookup (id/name/logo only) for showing the team a driver raced for on a given race_scores row — see `RaceResultRow.team`. Exported (like `driversSelect`) so a caller needing several team-scoped views at once — the homepage standings widget's Alpha/Delta team tabs — can fetch this once and share it via `teamsBasic`, instead of each tab re-fetching it. */
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
