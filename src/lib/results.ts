/**
 * Season standings, champions, and race results — computed from the tables
 * an external iRacing-results import pipeline populates (curated_rounds,
 * curated_race_results, curated_qualifying, race_scores). None of those
 * tables are created by this repo (see supabase/migrations/0004_champions.sql);
 * this file only reads them.
 *
 * TWO IMPORTANT, CONFIRMED-WITH-LOGAN ASSUMPTIONS BAKED IN HERE:
 *
 * 1. Class-relative finishing position is NOT the same as
 *    `race_scores.scored_position` — that column is an OVERALL field
 *    position across every class combined. To get a driver's position
 *    within their own class (needed for wins/podiums/top 5s/top 10s), this
 *    file re-ranks each race itself, using `curated_race_results` (the raw
 *    imported results) restricted to just the drivers `race_scores` says
 *    were in this class for that season (both `computeSeasonStandings` and
 *    `getRoundResults` below, for its per-class output, do this same
 *    re-ranking — its overall/cross-class output uses `scored_position`
 *    directly instead, since that field already is the overall position).
 *    Per race,
 *    the position used is `adjusted_position` (post-penalty) when set,
 *    falling back to `finish_position` (pre-penalty) otherwise; whenever a
 *    row actually has an `adjusted_position`, that's flagged so the UI can
 *    indicate a penalty affected the result.
 *
 * 2. Season point totals drop each driver's worst 2 rounds, PLUS whatever
 *    `seasons.extra_drop_weeks` adds on top for that season (Logan: "the
 *    baseline amount is 2 drop weeks"). A "round" here is one subsession_id
 *    — i.e. race1+race2+race3 (when present) are summed together as a
 *    single droppable unit, not dropped individually. If dropping that many
 *    rounds would leave zero counted, at least 1 round is always kept
 *    (protects very young seasons/classes — e.g. Gamma didn't exist before
 *    ATC16 and Delta before ATC5, so their early seasons have few rounds).
 *
 * Poles are read from `race_scores.pole_bonus` (only ever nonzero on a
 * round's fresh-qualifying race — races 2/3 run an inverted grid off race 1
 * and don't earn one), counted once per round (`subsession_id`), matching
 * "poles are based on appearances, not starts."
 */

import {
  restGet,
  restGetAll,
  getExhibitionRoundIds,
  getCarLogos,
  getSeasons,
  getPenaltiesForSubsessions,
  getAllTeamSeasonLogos,
  getDriverClasses,
  formatLapTime,
  displayDriverName,
  getCircuits,
  getAllCircuitLayouts,
  type SupabaseEnv,
} from './supabase';
import type { Season, CarLogo, Penalty, Lookup, Circuit, CircuitLayout } from './supabase';
import {
  computeSeasonOverallAdjustments,
  computeSeasonClassAdjustments,
  effectivePenaltyPoints,
  type SeasonScoreRow,
  type SeasonClassScoreRow,
  type SeasonOverallAdjustment,
  type LeaderRaceStats,
  type Format,
} from './penalties';

/**
 * Real championship seasons are named like "ATC17" — anything that doesn't
 * match is some kind of non-points-paying/for-fun season or event (Logan:
 * "Any season of racing that doesn't follow the ATCX naming format... should
 * be excluded from all statistics"). This is intentionally name-derived
 * rather than a schema flag — no existing column captures it, and the
 * naming convention already fully determines it.
 *
 * A round *inside* an otherwise-real championship season can also be a
 * non-points exhibition (e.g. a pre-season race) — that's handled
 * separately via the `round_overrides` table (see `getExhibitionRoundIds`
 * in src/lib/supabase.ts and 0005_round_overrides.sql).
 */
export function isChampionshipSeason(seasonName: string): boolean {
  return /^ATC\d+$/i.test(seasonName.trim());
}

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

interface RaceScoreRow {
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
  classified: boolean;
  dsq: boolean;
}

interface CuratedRaceResultRow {
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
  status: 'provisional' | 'official' | 'unofficial';
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
}

/** Exported so a caller needing MULTIPLE standings views for one season (e.g. the homepage's standings widget) can fetch this once and pass it as `driversBasic` to each call, same sharing reasoning as `getSeasonOverallContext`. */
export function driversSelect(env: SupabaseEnv) {
  return restGet<DriverBasic[]>(env, 'drivers?select=id,name,car_number,photo_url,iracing_cust_id,is_rookie,nationality_1,nationality_2');
}

function getRaceScoresForSeasonClass(env: SupabaseEnv, seasonId: string, classId: number) {
  const select =
    'subsession_id,race_number,driver_id,team_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,classified,dsq';
  return restGet<RaceScoreRow[]>(
    env,
    `race_scores?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}`
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
function getRaceScoresForSeasonsBulk(env: SupabaseEnv, seasonIds: string[]) {
  if (seasonIds.length === 0) return Promise.resolve([] as RaceScoreBulkRow[]);
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,season_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,classified,dsq,finish_points,scored_position';
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
    `race_scores?select=${select}&season_id=in.(${seasonIds.map((id) => encodeURIComponent(id)).join(',')})&order=subsession_id.asc,race_number.asc,driver_id.asc`
  );
}

interface RaceScoreOverallRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  team_id: string | null;
  finish_points: number;
  finesse_bonus: number;
  pole_bonus: number;
  points_deduction: number;
  dsq: boolean;
  classified: boolean;
  scored_position: number | null;
}

/** Every class combined — see `computeOverallSeasonStandings` and `getSeasonCarTeamStats`. */
function getRaceScoresForSeasonOverall(env: SupabaseEnv, seasonId: string) {
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,finish_points,finesse_bonus,pole_bonus,points_deduction,dsq,classified,scored_position';
  return restGet<RaceScoreOverallRow[]>(
    env,
    `race_scores?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
}

function getCuratedRaceResultsForSubsessions(env: SupabaseEnv, subsessionIds: number[]) {
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
    `curated_race_results?select=${select}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`
  );
}

interface RawLapStatsRow {
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
async function getLapStatsForSubsessions(env: SupabaseEnv, subsessionIds: number[]): Promise<RawLapStatsRow[]> {
  if (subsessionIds.length === 0) return [];
  try {
    // restGetAll — same reasoning (and same explicit order, for the same
    // paginated-stability reason) as getCuratedRaceResultsForSubsessions.
    return await restGetAll<RawLapStatsRow>(
      env,
      `curated_race_results?select=subsession_id,race_number,cust_id,average_lap_ten_thousandths,best_lap_ten_thousandths&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`
    );
  } catch (err) {
    console.error('Failed to fetch average/best lap data (curated_race_results.average_lap_ten_thousandths) — falling back to interval-only penalty ranking and omitting lap-time stats:', err);
    return [];
  }
}

interface TeamBasic {
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
function buildSeasonLogoMap(rows: { team_id: string; season_id: string; logo_url: string }[]): Map<string, string> {
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
    console.error('Failed to fetch team_season_logos (migration 0019 not applied yet?) — falling back to current team logos only:', err);
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
function resolveTeamLogo(team: TeamBasic, seasonId: string | null, seasonLogos: Map<string, string>): string | null {
  if (seasonId) {
    const override = seasonLogos.get(teamSeasonLogoKey(team.id, seasonId));
    if (override) return override;
  }
  return team.logo_url;
}

function resultKey(subsessionId: number, raceNumber: number, custId: number) {
  return `${subsessionId}:${raceNumber}:${custId}`;
}

// ---------------------------------------------------------------------------
// Season-wide penalty context — shared plumbing behind computeSeasonStandings
// and computeOverallSeasonStandings so a penalty logged on the results page
// (src/pages/results/[subsessionId].astro) also ripples into both standings
// views, not just that one round's own page. See src/lib/penalties.ts's
// computeSeasonOverallAdjustments/computeSeasonClassAdjustments for the
// actual recompute math — this just fetches what those need.
// ---------------------------------------------------------------------------

export interface CurrentSeasonRounds {
  season: Season | null;
  subsessionIds: number[];
  formatBySubsession: Map<number, Format | null>;
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

interface SeasonOverallContext {
  /** (subsessionId:raceNumber:driverId) -> adjustment, only for races a penalty actually touched. */
  adjustments: Map<string, SeasonOverallAdjustment>;
  penalties: Penalty[];
  formatBySubsession: Map<number, Format | null>;
  rawByKey: Map<string, CuratedRaceResultRow>;
  overallScores: RaceScoreOverallRow[];
  custIdByDriverId: Map<string, number>;
  /** (subsessionId:raceNumber) -> that race's actual leader's own laps/average-lap — see src/lib/penalties.ts's computeSeasonClassAdjustments, which needs this since its own rows are already filtered to one class and may not contain the (possibly different-class) overall leader. */
  leaderStatsByRace: Map<string, LeaderRaceStats>;
  /** (subsessionId:raceNumber:custId) -> that result's average/best lap data — exposed so computeSeasonStandings can attach lapsComplete/averageLapTenThousandths onto its per-class rows (rule 18.3.2's estimated-overall-race-time path) without re-querying. */
  lapStatsByKey: Map<string, RawLapStatsRow>;
  /** This season's own `curated_rounds` rows (the same fetch `formatBySubsession` is derived from) — exposed so a caller that also needs another field off these rows (e.g. `getSeasonDriverExtendedStats`' track_name lookup for distance/corners) can reuse this instead of re-querying `curated_rounds` a second time for the same season. */
  seasonRounds: RoundSummary[];
}

/**
 * Fetches everything needed to know how this season's penalties affect
 * OVERALL (cross-class) field position and finish points. Shared by both
 * computeSeasonStandings (which additionally layers its own class-relative
 * class_points recompute on top — a class's finish points still depend on
 * the OVERALL position, which a penalty against a driver in a *different*
 * class in the same race can also shift) and computeOverallSeasonStandings
 * (which uses this directly, since the overall view never awards
 * class_points at all) — kept as one function so the two views can never
 * derive a different overall position/finish-points number for the same
 * driver in the same race.
 *
 * This is just a thin fetch-then-build wrapper around `buildSeasonOverallContext`
 * (below) — every single-season caller (Standings, Team Standings, Champions,
 * Race Results) goes through this one-season-at-a-time fetch exactly as
 * before. `computeDriverCareerStats`, which needs this same context for
 * MANY seasons at once, instead bulk-fetches the same 4 raw ingredients
 * ONCE across every season and calls `buildSeasonOverallContext` directly
 * per season on its own already-in-memory slice — no network calls in that
 * per-season loop at all. Splitting this function was what let that happen
 * without duplicating (and risking drifting from) the actual adjustment
 * math below.
 *
 * Exported so any other caller that needs MULTIPLE standings views for the
 * same single season — e.g. the homepage's Overall/Alpha/Gamma/Delta/
 * Rookies standings widget — can build this once and pass it as
 * `precomputedOverallContext` to each of computeSeasonStandings /
 * computeOverallSeasonStandings, instead of each view re-fetching its own
 * copy. Same sharing story as computeDriverCareerStats, just for "many
 * views, one season" instead of "one view, many seasons."
 */
export async function getSeasonOverallContext(
  env: SupabaseEnv,
  season: Season,
  exhibitionIds: Set<number>,
  drivers: DriverBasic[]
): Promise<SeasonOverallContext> {
  const overallScoresRaw = await getRaceScoresForSeasonOverall(env, season.id);
  // Same exhibition-filtered scope the original single fetch-and-build
  // version used for its subsessionIds — buildSeasonOverallContext below
  // re-derives this same filtered set itself (cheap, in-memory), so this
  // is just to keep this wrapper's OWN fetches scoped to exactly the same
  // rounds as before, not a behavior change.
  const filteredForFetchScope =
    exhibitionIds.size > 0 ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : overallScoresRaw;
  const subsessionIds = [...new Set(filteredForFetchScope.map((s) => s.subsession_id))];
  const [rawResults, penalties, seasonRounds, lapStats] = await Promise.all([
    getCuratedRaceResultsForSubsessions(env, subsessionIds),
    getPenaltiesForSubsessions(env, subsessionIds),
    getRoundsForSeason(env, season.id),
    getLapStatsForSubsessions(env, subsessionIds),
  ]);

  return buildSeasonOverallContext(exhibitionIds, drivers, overallScoresRaw, rawResults, penalties, seasonRounds, lapStats);
}

/**
 * Pure (no network) half of `getSeasonOverallContext` — everything from
 * that function's body that isn't itself a fetch, taking the same 4 raw
 * ingredients (this season's race_scores, curated_race_results, penalties,
 * curated_rounds, plus average/best lap data) as plain arrays instead of
 * fetching them. `getSeasonOverallContext` calls this immediately after its
 * own one-season fetch; `computeDriverCareerStats` calls this directly,
 * once per season, on slices of ONE bulk multi-season fetch instead —
 * see that function's own doc comment for why.
 */
function buildSeasonOverallContext(
  exhibitionIds: Set<number>,
  drivers: DriverBasic[],
  overallScoresRaw: RaceScoreOverallRow[],
  rawResults: CuratedRaceResultRow[],
  penalties: Penalty[],
  seasonRounds: RoundSummary[],
  lapStats: RawLapStatsRow[]
): SeasonOverallContext {
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );

  const overallScores =
    exhibitionIds.size > 0 ? overallScoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : overallScoresRaw;

  if (overallScores.length === 0) {
    return {
      adjustments: new Map(),
      penalties: [],
      formatBySubsession: new Map(),
      rawByKey: new Map(),
      overallScores: [],
      custIdByDriverId,
      leaderStatsByRace: new Map(),
      lapStatsByKey: new Map(),
      seasonRounds: [],
    };
  }

  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const lapStatsByKey = new Map(lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const formatBySubsession = new Map(seasonRounds.map((r) => [r.subsession_id, r.format]));

  // This season's race leaders (rule 18.3.2's reference point — see
  // src/lib/penalties.ts's Position recalculation header) — every touched
  // race's own actual on-track winner, pre-penalty, keyed the same way
  // computeSeasonClassAdjustments looks it up.
  const leaderStatsByRace = new Map<string, LeaderRaceStats>();
  for (const r of rawResults) {
    if (r.finish_position === 1) {
      leaderStatsByRace.set(`${r.subsession_id}:${r.race_number}`, {
        lapsComplete: r.laps_complete,
        averageLapTenThousandths: lapStatsByKey.get(resultKey(r.subsession_id, r.race_number, r.cust_id))?.average_lap_ten_thousandths ?? null,
      });
    }
  }

  if (penalties.length === 0) {
    return { adjustments: new Map(), penalties, formatBySubsession, rawByKey, overallScores, custIdByDriverId, leaderStatsByRace, lapStatsByKey, seasonRounds };
  }

  const seasonScoreRows: SeasonScoreRow[] = overallScores.map((s) => {
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    const lapStatsRow = custId != null ? lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    return {
      subsessionId: s.subsession_id,
      raceNumber: s.race_number,
      driverId: s.driver_id,
      dsq: s.dsq,
      classified: s.classified,
      scoredPosition: s.scored_position,
      intervalTenThousandths: raw?.interval_ten_thousandths ?? null,
      finishPoints: s.finish_points,
      finesseBonus: s.finesse_bonus,
      poleBonus: s.pole_bonus,
      pointsDeduction: s.points_deduction,
      lapsComplete: raw?.laps_complete ?? null,
      averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
    };
  });

  const adjustments = computeSeasonOverallAdjustments(seasonScoreRows, penalties, formatBySubsession);
  return { adjustments, penalties, formatBySubsession, rawByKey, overallScores, custIdByDriverId, leaderStatsByRace, lapStatsByKey, seasonRounds };
}

// ---------------------------------------------------------------------------
// Season standings
// ---------------------------------------------------------------------------

export interface DriverSeasonStanding {
  driver: DriverBasic;
  position: number;
  totalPoints: number;
  starts: number;
  appearances: number;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  /** Season total laps led (curated_race_results.laps_led, summed across every race counted for this view) — shown in the standings driver detail panel and used as a tiebreaker (see finalizeStandings). */
  lapsLed: number;
  /** Season total laps completed (curated_race_results.laps_complete, summed across every race counted for this view) — same uses as lapsLed. */
  laps: number;
  /** Only set by `computeOverallSeasonStandings` — which class this driver actually raced, so the overall (every class combined) table can still show it. */
  classId?: number;
}

const BASELINE_DROP_WEEKS = 2;

interface StandingsAccum {
  starts: number;
  subsessionIds: Set<number>;
  poleSubsessionIds: Set<number>;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  lapsLed: number;
  laps: number;
  roundPoints: Map<number, number>;
  classId?: number;
}

function newStandingsAccum(): StandingsAccum {
  return {
    starts: 0,
    subsessionIds: new Set(),
    poleSubsessionIds: new Set(),
    wins: 0,
    podiums: 0,
    top5s: 0,
    top10s: 0,
    lapsLed: 0,
    laps: 0,
    roundPoints: new Map(),
  };
}

/**
 * Shared by both `computeSeasonStandings` and `computeOverallSeasonStandings`
 * — turns the per-driver accumulators built by each into sorted, positioned
 * standings (worst-rounds-dropped point totals, then wins/podiums as
 * tiebreakers).
 *
 * `allSubsessionIds` is every round this season actually had (for the class
 * being computed, or every class for the overall view) — the drop-week pool
 * is padded out to that full set, not just the rounds a given driver has a
 * `roundPoints` entry for. A driver who scored 0 in a round they started
 * already gets a real (zero-valued) entry from the caller's own loop; a
 * round they didn't show up for at all never gets one, and without this
 * padding it would simply vanish from their pool instead of being an
 * available (and, being 0, likely-dropped) week — which meant the baseline
 * drop count kept eating into real scored rounds on top of whatever they'd
 * already missed, rather than the no-show weeks themselves being what's
 * dropped.
 *
 * Ties are broken by working through the standings columns in order, per
 * Logan: "wins, podiums, top 5s, top 10s, poles, laps led, laps, and
 * appearances. If they are still tied, alphabetical order." Whatever stats
 * `accum` was built with ARE already the right "variant" for the view being
 * computed — computeSeasonStandings' wins/podiums/top5s/top10s are already
 * that class's own class-relative stats (and, for Gamma/Delta, `poles` is
 * already that class's own Class Pole count), so this one comparator serves
 * every view without needing to know which one it's sorting.
 */
function finalizeStandings(
  accum: Map<string, StandingsAccum>,
  driverById: Map<string, DriverBasic>,
  season: Season,
  allSubsessionIds: Set<number>
): DriverSeasonStanding[] {
  const totalDrops = BASELINE_DROP_WEEKS + (season.extra_drop_weeks ?? 0);

  const standings: Omit<DriverSeasonStanding, 'position'>[] = [];
  for (const [driverId, a] of accum) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    const roundTotals = [...allSubsessionIds].map((id) => a.roundPoints.get(id) ?? 0).sort((x, y) => y - x);
    const dropCount = Math.min(totalDrops, Math.max(0, roundTotals.length - 1));
    const countedRounds = roundTotals.slice(0, roundTotals.length - dropCount);
    const totalPoints = countedRounds.reduce((sum, p) => sum + p, 0);

    standings.push({
      driver,
      totalPoints,
      starts: a.starts,
      appearances: a.subsessionIds.size,
      wins: a.wins,
      podiums: a.podiums,
      top5s: a.top5s,
      top10s: a.top10s,
      poles: a.poleSubsessionIds.size,
      lapsLed: a.lapsLed,
      laps: a.laps,
      classId: a.classId,
    });
  }

  standings.sort(
    (x, y) =>
      y.totalPoints - x.totalPoints ||
      y.wins - x.wins ||
      y.podiums - x.podiums ||
      y.top5s - x.top5s ||
      y.top10s - x.top10s ||
      y.poles - x.poles ||
      y.lapsLed - x.lapsLed ||
      y.laps - x.laps ||
      y.appearances - x.appearances ||
      displayDriverName(x.driver.name).localeCompare(displayDriverName(y.driver.name))
  );

  return standings.map((s, i) => ({ ...s, position: i + 1 }));
}

/**
 * Computes the full standings for one season+class, sorted by points
 * (ties broken by wins, then podiums). Pass a pre-fetched `driversBasic`
 * list (and `exhibitionRoundIds`, `classesLookup`) when computing many
 * seasons back to back (see `getChampions`) to avoid re-fetching the same
 * data every time.
 *
 * Returns an empty list for a non-championship (exhibition) season without
 * querying anything else — see `isChampionshipSeason`.
 */
export async function computeSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  classId: number,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>,
  classesLookup?: Lookup[],
  /**
   * A season-wide penalty context computed elsewhere and passed in so this
   * call doesn't re-fetch it — see `getSeasonOverallContext`'s own doc
   * comment. `computeDriverCareerStats` is the reason this exists: it needs
   * this same season's standings for every class plus the overall/team/
   * extended-stats views, and without sharing this one (expensive, ~5
   * query) fetch across all of them, a career-wide computation across many
   * seasons blows straight through Cloudflare Workers' per-request
   * subrequest limit. Every other caller just omits this and gets the
   * original one-context-per-call behavior.
   */
  precomputedOverallContext?: SeasonOverallContext,
  /** Same sharing reasoning as `precomputedOverallContext` — lets a caller that already fetched this class's own race_scores rows (e.g. computeTeamSeasonStandings' per-class team competition, which needs the identical rows) pass them in instead of querying twice. */
  precomputedScoresRaw?: RaceScoreRow[]
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [scoresRaw, drivers, exhibitionIds, classes] = await Promise.all([
    precomputedScoresRaw ? Promise.resolve(precomputedScoresRaw) : getRaceScoresForSeasonClass(env, season.id, classId),
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
    classesLookup ? Promise.resolve(classesLookup) : getDriverClasses(env),
  ]);
  // Alpha's own scoring never includes the top-3-in-class Class Points
  // bonus (that's Gamma/Delta's own per-race class-position bonus, see
  // README) — used below so a penalty-driven class-position change can
  // never manufacture Class Points for an Alpha driver.
  const awardsClassPoints = classes.find((c) => c.id === classId)?.name !== 'Alpha';
  // Individual rounds can be flagged exhibition even inside a real
  // championship season (e.g. a pre-season race) — those never count
  // toward standings, same as a whole exhibition season.
  const scores = exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );

  // Cross-class penalty context — this class's finish points are based on
  // OVERALL field position, which a penalty against a driver in a DIFFERENT
  // class in the same race can also shift, so this class's own (filtered)
  // `scores` alone isn't enough to know that. See getSeasonOverallContext.
  // Its own `rawByKey` already covers every subsession this whole SEASON
  // raced (a superset of this one class's own subsessions), so it doubles
  // as this class's curated_race_results lookup too — no separate fetch
  // needed for that anymore.
  const overallContext = precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  const rawByKey = overallContext.rawByKey;

  // Group this class's race_scores rows by (subsession_id, race_number) so
  // each individual race can be ranked within the class.
  const raceGroups = new Map<string, RaceScoreRow[]>();
  for (const s of scores) {
    const key = `${s.subsession_id}:${s.race_number}`;
    if (!raceGroups.has(key)) raceGroups.set(key, []);
    raceGroups.get(key)!.push(s);
  }

  const accum = new Map<string, StandingsAccum>();
  function getAccum(driverId: string): StandingsAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = newStandingsAccum();
      accum.set(driverId, a);
    }
    return a;
  }

  // Class-relative rank per race, using the raw imported position — same
  // derivation as before, but captured per (subsession,race,driver) so the
  // penalty engine has an "original class position" baseline to compare
  // against, whether or not this particular race actually has a penalty.
  const classScoreRows: SeasonClassScoreRow[] = [];
  const originalClassPositionByKey = new Map<string, number>();
  for (const [raceKey, group] of raceGroups) {
    const ranked = group
      .filter((s) => !s.dsq)
      .map((s) => {
        const custId = custIdByDriverId.get(s.driver_id);
        const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
        const lapStatsRow =
          custId != null ? overallContext.lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
        return {
          score: s,
          position: raw?.adjusted_position ?? raw?.finish_position ?? null,
          interval: raw?.interval_ten_thousandths ?? null,
          lapsComplete: raw?.laps_complete ?? null,
          averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
        };
      })
      .filter((r) => r.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number));

    ranked.forEach((r, i) => {
      const classPosition = i + 1;
      const key = `${raceKey}:${r.score.driver_id}`;
      originalClassPositionByKey.set(key, classPosition);
      classScoreRows.push({
        subsessionId: r.score.subsession_id,
        raceNumber: r.score.race_number,
        driverId: r.score.driver_id,
        dsq: r.score.dsq,
        classified: r.score.classified,
        classPosition,
        intervalTenThousandths: r.interval,
        totalPoints: r.score.total_points,
        classPoints: r.score.class_points,
        finesseBonus: r.score.finesse_bonus,
        poleBonus: r.score.pole_bonus,
        pointsDeduction: r.score.points_deduction,
        lapsComplete: r.lapsComplete,
        averageLapTenThousandths: r.averageLapTenThousandths,
      });
    });
  }

  const classAdjustments = computeSeasonClassAdjustments(
    classScoreRows,
    overallContext.penalties,
    overallContext.formatBySubsession,
    overallContext.adjustments,
    overallContext.leaderStatsByRace,
    awardsClassPoints
  );

  // Disqualified results are excluded from ranking entirely (not just
  // demoted to last) so a DSQ'd driver can never be credited with a
  // win/podium/top 5/top 10, and everyone behind them ranks up normally —
  // they still count toward that driver's own starts/appearances/points
  // below, just not toward anyone's class position. Uses the
  // penalty-adjusted class rank when this race actually had one logged,
  // otherwise the original rank exactly as before.
  for (const [raceKey, group] of raceGroups) {
    for (const s of group) {
      if (s.dsq) continue;
      const key = `${raceKey}:${s.driver_id}`;
      const adjustment = classAdjustments.get(key);
      const classRank = adjustment ? adjustment.newClassPosition : originalClassPositionByKey.get(key) ?? null;
      if (classRank === null) continue;
      const a = getAccum(s.driver_id);
      if (classRank === 1) a.wins++;
      if (classRank <= 3) a.podiums++;
      if (classRank <= 5) a.top5s++;
      if (classRank <= 10) a.top10s++;
    }
  }

  // Alpha never earns its own "Class Pole" bonus (pole_bonus is
  // structurally always 0 for Alpha — see README/computeOverallSeasonStandings'
  // doc comment), so its "poles" stat — displayed and used as a tiebreaker —
  // falls back to the true overall pole-sitter instead, same as the Overall
  // view. Gamma/Delta keep using their own real Class Pole (pole_bonus).
  const isAlphaClass = !awardsClassPoints;
  const overallPoleDriverBySubsession = isAlphaClass ? computeOverallPoleDriverBySubsession(overallContext) : null;

  // Alpha's points MUST come from the exact same source computeOverallSeasonStandings
  // uses (finish_points + finesse_bonus + pole_bonus + points_deduction, with
  // overallContext's OWN cross-class penalty adjustment applied) rather than
  // this class's own classAdjustments/raw total_points — see the bug this
  // fixes: `computeSeasonClassAdjustments` above only reprocesses a race when
  // one of THIS class's own drivers was directly penalized
  // (`computeSeasonClassAdjustments`'s `touched` check). A penalty against a
  // driver in a DIFFERENT class can still shift an Alpha driver's OVERALL
  // cross-class position (and therefore their position-based finish_points)
  // without touching anything Alpha-relative at all — `computeSeasonOverallAdjustments`
  // correctly catches that ripple (its own `touched` check is keyed off ANY
  // driver in the race, any class), but the class-scoped pass above never
  // sees it, so Alpha's per-class points silently stayed stuck at the
  // pre-penalty (too-low, once the ripple should have moved them UP) value.
  // Since Alpha never earns class_points, "Alpha standings" isn't really a
  // separate competition from "Overall" at all — it's Overall's own formula,
  // just reported per-class — so sourcing points from `overallContext`
  // directly instead of re-deriving them class-locally is both the fix and
  // the more honest model of what this table actually is.
  const overallPointsByKey = isAlphaClass
    ? new Map(
        overallContext.overallScores
          .filter((s) => s.class_id === classId)
          .map((s) => {
            const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
            const adjustment = overallContext.adjustments.get(key);
            const points = adjustment ? adjustment.overallTotalPoints : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
            return [key, points] as const;
          })
      )
    : null;

  // Starts, appearances, poles, and points come straight from race_scores
  // regardless of whether a matching curated_race_results row was found —
  // except total_points, which uses the penalty-adjusted figure whenever
  // this race actually has one logged.
  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    if (isAlphaClass) {
      if (overallPoleDriverBySubsession!.get(s.subsession_id) === s.driver_id) a.poleSubsessionIds.add(s.subsession_id);
    } else if (s.pole_bonus > 0) {
      a.poleSubsessionIds.add(s.subsession_id);
    }
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    a.lapsLed += raw?.laps_led ?? 0;
    a.laps += raw?.laps_complete ?? 0;
    const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
    let totalPoints: number;
    if (isAlphaClass) {
      // Falls back to this class's own raw total_points only if this row is
      // somehow missing from overallContext.overallScores (shouldn't happen
      // — that fetch covers every class every one of this class's rows also
      // appears in — but never worse than the pre-fix behavior if it did).
      totalPoints = overallPointsByKey!.get(key) ?? s.total_points;
    } else {
      const adjustment = classAdjustments.get(key);
      totalPoints = adjustment ? adjustment.totalPoints : s.total_points;
    }
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + totalPoints);
  }

  // Every round this class actually raced this season (already
  // exhibition-filtered, same as `scores`) — see finalizeStandings' own doc
  // comment on why a driver's missed rounds need to be in this pool too.
  const allSubsessionIds = new Set(scores.map((s) => s.subsession_id));
  return finalizeStandings(accum, driverById, season, allSubsessionIds);
}

/**
 * subsessionId -> the driver who actually had grid position 1 on that
 * round's race 1 — the TRUE overall pole-sitter, as opposed to
 * `race_scores.pole_bonus` (each class's own "Class Pole" — fastest
 * qualifier within just that driver's own class; see
 * `computeOverallSeasonStandings`' own doc comment for why that's not the
 * same thing). Shared by `computeOverallSeasonStandings` (which always needs
 * the true overall pole) and `computeSeasonStandings` — but only for the
 * Alpha class, which never earns its own "Class Pole" bonus (Alpha doesn't
 * get class_points/pole_bonus at all — see README), so Alpha's own
 * `pole_bonus` count is structurally always 0 and can't stand in as a real
 * "poles" stat or tiebreaker column the way it can for Gamma/Delta.
 */
function computeOverallPoleDriverBySubsession(context: SeasonOverallContext): Map<number, string> {
  const custIdToDriverId = new Map([...context.custIdByDriverId].map(([driverId, custId]) => [custId, driverId]));
  const overallPoleDriverBySubsession = new Map<number, string>();
  for (const raw of context.rawByKey.values()) {
    if (raw.race_number === 1 && raw.starting_position === 1) {
      const driverId = custIdToDriverId.get(raw.cust_id);
      if (driverId) overallPoleDriverBySubsession.set(raw.subsession_id, driverId);
    }
  }
  return overallPoleDriverBySubsession;
}

/**
 * Every class combined into one table, ranked by the same points formula
 * Alpha already effectively uses — `finish_points + finesse_bonus +
 * pole_bonus + points_deduction`, deliberately excluding `class_points`
 * (Logan: "class points for gammas and deltas are not counted... it should
 * essentially be the alpha standings with everyone included"), since
 * `class_points` is Delta/Gamma's own per-race class-position bonus and
 * Alpha never has one — leaving it in would make Alpha drivers structurally
 * unable to compete for the same "overall" total.
 *
 * Wins/podiums/top 5s/top 10s here come straight from
 * `race_scores.scored_position` (the overall field position across every
 * class, already computed by the pipeline) rather than the per-class
 * re-derivation `computeSeasonStandings` does — same approach the race
 * results page's "Overall" view uses.
 *
 * Poles are the one stat that DOESN'T come from `race_scores.pole_bonus`
 * here, unlike every other view — that column is actually Gamma/Delta's own
 * "Class Pole" bonus (fastest qualifier within just that driver's class),
 * so using it in a cross-class table would credit a driver with a "pole"
 * for merely out-qualifying their own class, not the whole grid. This view
 * instead derives the real overall pole-sitter straight from
 * `curated_race_results.starting_position` on each round's race 1 (the only
 * race with real qualifying — 2/3 invert off it, per the same rule that
 * keeps them from ever earning `pole_bonus`).
 */
export async function computeOverallSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>,
  /** See `computeSeasonStandings`' identical param — shares one season-wide penalty context across every view instead of each fetching its own. */
  precomputedOverallContext?: SeasonOverallContext
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [drivers, exhibitionIds] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
  ]);

  const overallContext = precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  const scores = overallContext.overallScores;
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const accum = new Map<string, StandingsAccum>();
  function getAccum(driverId: string): StandingsAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = newStandingsAccum();
      accum.set(driverId, a);
    }
    return a;
  }

  const overallPoleDriverBySubsession = computeOverallPoleDriverBySubsession(overallContext);

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.classId = s.class_id;
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    if (overallPoleDriverBySubsession.get(s.subsession_id) === s.driver_id) a.poleSubsessionIds.add(s.subsession_id);

    const custId = overallContext.custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? overallContext.rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    a.lapsLed += raw?.laps_led ?? 0;
    a.laps += raw?.laps_complete ?? 0;

    const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
    const adjustment = overallContext.adjustments.get(key);
    const points = adjustment ? adjustment.overallTotalPoints : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + points);

    const position = adjustment ? adjustment.newPosition : s.scored_position;
    if (!s.dsq && position !== null) {
      if (position === 1) a.wins++;
      if (position <= 3) a.podiums++;
      if (position <= 5) a.top5s++;
      if (position <= 10) a.top10s++;
    }
  }

  // Every round the season actually had, across every class (already
  // exhibition-filtered, same as `scores`) — see finalizeStandings' own doc
  // comment on why a driver's missed rounds need to be in this pool too.
  const allSubsessionIds = new Set(scores.map((s) => s.subsession_id));
  return finalizeStandings(accum, driverById, season, allSubsessionIds);
}

export interface TeamSeasonStanding {
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  position: number;
  totalPoints: number;
  /** Every race any of this team's drivers started this season — not just races they were one of the top 2 scorers in. */
  starts: number;
  /** Distinct rounds (subsession_ids) this team had at least one driver in. */
  appearances: number;
  /** Every driver who raced for this team this season, at least once — used to build the team-standings page's expandable roster detail (overall championship position/points/starts come from `computeOverallSeasonStandings`, joined in at the page level). */
  driverIds: string[];
}

/**
 * Final team standings for one season — every round's points count, no
 * drop weeks. Unlike driver standings (`finalizeStandings`' baseline-2 +
 * `season.extra_drop_weeks` rule), the team championship has no
 * worst-rounds-dropped rule at all — per Logan, drop weeks are specific to
 * the driver championships. (An earlier version of this function
 * mistakenly applied the same drop-week math here too; fixed.)
 *
 * A team's points for a given round are the sum of just its top 2 scoring
 * drivers that round (`topTeamScorers()` — same rule the news recap's Team
 * Scoring Breakdown and the results page's per-driver "Team Points" detail
 * both use).
 *
 * `classId` picks which team competition this is, same distinction the news
 * recap's `topTeamOverall` vs `topTeamDelta` already draws:
 * - Omitted (default): the OVERALL (every class combined) competition, by
 *   the same class-blind points formula `computeOverallSeasonStandings`
 *   uses (`finish_points + finesse_bonus + pole_bonus + points_deduction`,
 *   class_points excluded) — so a Gamma/Delta driver's own class_points
 *   bonus can't give their team an edge a same-performing Alpha driver's
 *   team wouldn't also get.
 * - Set to a class id (e.g. Delta's): that class's own SEPARATE team
 *   competition, scored by that class's full per-race total_points
 *   (class_points included — matching newsRecap.ts's `deltaPointsOf`) and
 *   scoped to only that class's own races/drivers. Requires re-deriving
 *   that class's own penalty-adjusted totals (`computeSeasonClassAdjustments`)
 *   — the same setup `computeSeasonStandings` builds for itself, duplicated
 *   here rather than shared since team points only need the adjusted TOTAL
 *   POINTS per (race, driver), not the full standings pipeline built on top
 *   of it.
 *
 * Either way, never a team's 3rd (or more) driver's points in any single
 * race.
 */
export async function computeTeamSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>,
  classId?: number,
  driversBasic?: DriverBasic[],
  teamsBasic?: TeamBasic[],
  /** Rows from `getAllTeamSeasonLogosSafe` — see `computeSeasonStandings`' `precomputedOverallContext` param for why sharing these matters (`computeDriverCareerStats` calls this twice per season, overall + Delta). */
  seasonLogoRowsParam?: { team_id: string; season_id: string; logo_url: string }[],
  classesLookup?: Lookup[],
  precomputedOverallContext?: SeasonOverallContext,
  /** Only meaningful for the per-class branch (`classId` set) — see `computeSeasonStandings`' identical param. */
  precomputedScoresRaw?: RaceScoreRow[]
): Promise<TeamSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [drivers, exhibitionIds, teams, seasonLogoRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
    teamsBasic ? Promise.resolve(teamsBasic) : getTeamsBasic(env),
    seasonLogoRowsParam ? Promise.resolve(seasonLogoRowsParam) : getAllTeamSeasonLogosSafe(env),
  ]);

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  interface TeamAccum {
    starts: number;
    subsessionIds: Set<number>;
    roundPoints: Map<number, number>;
    driverIds: Set<string>;
  }
  const accum = new Map<string, TeamAccum>();
  function getAccum(teamId: string): TeamAccum {
    let a = accum.get(teamId);
    if (!a) {
      a = { starts: 0, subsessionIds: new Set(), roundPoints: new Map(), driverIds: new Set() };
      accum.set(teamId, a);
    }
    return a;
  }

  if (classId === undefined) {
    // ---- Overall (cross-class) team competition ----
    const overallContext = precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
    const scores = overallContext.overallScores;
    if (scores.length === 0) return [];

    const pointsOf = (s: RaceScoreOverallRow) => {
      const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
      const adjustment = overallContext.adjustments.get(key);
      return adjustment ? adjustment.overallTotalPoints : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
    };

    // Starts/appearances count every row for the team, same as a driver's
    // own starts/appearances — only the POINTS below are limited to the top 2.
    const raceTeamGroups = new Map<string, RaceScoreOverallRow[]>(); // "subsession:race:team" -> that team's rows for that race
    for (const s of scores) {
      if (!s.team_id) continue;
      const a = getAccum(s.team_id);
      a.starts += 1;
      a.subsessionIds.add(s.subsession_id);
      a.driverIds.add(s.driver_id);

      const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
      if (!raceTeamGroups.has(key)) raceTeamGroups.set(key, []);
      raceTeamGroups.get(key)!.push(s);
    }

    for (const group of raceTeamGroups.values()) {
      const subsessionId = group[0].subsession_id;
      const teamId = group[0].team_id as string;
      const roundSum = topTeamScorers(group, pointsOf).reduce((sum, s) => sum + pointsOf(s), 0);
      const a = getAccum(teamId);
      a.roundPoints.set(subsessionId, (a.roundPoints.get(subsessionId) ?? 0) + roundSum);
    }
  } else {
    // ---- One class's own separate team competition (e.g. Delta's) ----
    const [scoresRaw, classes] = await Promise.all([
      precomputedScoresRaw ? Promise.resolve(precomputedScoresRaw) : getRaceScoresForSeasonClass(env, season.id, classId),
      classesLookup ? Promise.resolve(classesLookup) : getDriverClasses(env),
    ]);
    const awardsClassPoints = classes.find((c) => c.id === classId)?.name !== 'Alpha';
    const scores = exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
    if (scores.length === 0) return [];

    const custIdByDriverId = new Map(
      drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
    );

    // Cross-class penalty context — same reasoning as computeSeasonStandings.
    // Its rawByKey already covers every subsession this whole season raced,
    // so it doubles as this class's curated_race_results lookup too — no
    // separate fetch needed for that anymore (see computeSeasonStandings'
    // identical optimization).
    const overallContext = precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
    const rawByKey = overallContext.rawByKey;

    // Re-derive this class's own class-relative rank per race, and its
    // penalty-adjusted totals — the exact same setup computeSeasonStandings
    // builds for its own standings pass (see that function for the full
    // reasoning on each step).
    const raceGroups = new Map<string, RaceScoreRow[]>();
    for (const s of scores) {
      const key = `${s.subsession_id}:${s.race_number}`;
      if (!raceGroups.has(key)) raceGroups.set(key, []);
      raceGroups.get(key)!.push(s);
    }
    const classScoreRows: SeasonClassScoreRow[] = [];
    for (const [raceKey, group] of raceGroups) {
      const ranked = group
        .filter((s) => !s.dsq)
        .map((s) => {
          const custId = custIdByDriverId.get(s.driver_id);
          const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
          const lapStatsRow =
            custId != null ? overallContext.lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
          return {
            score: s,
            position: raw?.adjusted_position ?? raw?.finish_position ?? null,
            interval: raw?.interval_ten_thousandths ?? null,
            lapsComplete: raw?.laps_complete ?? null,
            averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
          };
        })
        .filter((r) => r.position !== null)
        .sort((a, b) => (a.position as number) - (b.position as number));

      ranked.forEach((r, i) => {
        classScoreRows.push({
          subsessionId: r.score.subsession_id,
          raceNumber: r.score.race_number,
          driverId: r.score.driver_id,
          dsq: r.score.dsq,
          classified: r.score.classified,
          classPosition: i + 1,
          intervalTenThousandths: r.interval,
          totalPoints: r.score.total_points,
          classPoints: r.score.class_points,
          finesseBonus: r.score.finesse_bonus,
          poleBonus: r.score.pole_bonus,
          pointsDeduction: r.score.points_deduction,
          lapsComplete: r.lapsComplete,
          averageLapTenThousandths: r.averageLapTenThousandths,
        });
      });
    }

    const classAdjustments = computeSeasonClassAdjustments(
      classScoreRows,
      overallContext.penalties,
      overallContext.formatBySubsession,
      overallContext.adjustments,
      overallContext.leaderStatsByRace,
      awardsClassPoints
    );

    // Alpha Team points must come from the same source computeSeasonStandings'
    // isAlphaClass branch uses (see that function's own doc comment for the
    // full bug this fixes) — class-scoped `classAdjustments` above only
    // reprocesses a race when one of THIS class's own drivers was directly
    // penalized, missing cross-class penalty ripples that can still shift an
    // Alpha driver's overall position (and therefore their finish_points)
    // via a different class's driver being penalized in the same race.
    const isAlphaClass = !awardsClassPoints;
    const overallPointsByKey = isAlphaClass
      ? new Map(
          overallContext.overallScores
            .filter((s) => s.class_id === classId)
            .map((s) => {
              const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
              const adjustment = overallContext.adjustments.get(key);
              const points = adjustment ? adjustment.overallTotalPoints : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
              return [key, points] as const;
            })
        )
      : null;

    const pointsOf = (s: RaceScoreRow) => {
      const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
      if (isAlphaClass) return overallPointsByKey!.get(key) ?? s.total_points;
      const adjustment = classAdjustments.get(key);
      return adjustment ? adjustment.totalPoints : s.total_points;
    };

    const raceTeamGroups = new Map<string, RaceScoreRow[]>();
    for (const s of scores) {
      if (!s.team_id) continue;
      const a = getAccum(s.team_id);
      a.starts += 1;
      a.subsessionIds.add(s.subsession_id);
      a.driverIds.add(s.driver_id);

      const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
      if (!raceTeamGroups.has(key)) raceTeamGroups.set(key, []);
      raceTeamGroups.get(key)!.push(s);
    }

    for (const group of raceTeamGroups.values()) {
      const subsessionId = group[0].subsession_id;
      const teamId = group[0].team_id as string;
      const roundSum = topTeamScorers(group, pointsOf).reduce((sum, s) => sum + pointsOf(s), 0);
      const a = getAccum(teamId);
      a.roundPoints.set(subsessionId, (a.roundPoints.get(subsessionId) ?? 0) + roundSum);
    }
  }

  // Unlike driver standings, the team championship does NOT drop worst
  // rounds — every round a team scored in counts toward its total. Per
  // Logan: drop weeks are a driver-standings-only rule. (This function used
  // to apply the same BASELINE_DROP_WEEKS + extra_drop_weeks logic
  // finalizeStandings uses for drivers — that was a bug, not an intentional
  // shared rule.)
  const standings: Omit<TeamSeasonStanding, 'position'>[] = [];
  for (const [teamId, a] of accum) {
    const team = teamById.get(teamId);
    if (!team) continue; // team record deleted/missing — skip rather than crash the page

    const totalPoints = [...a.roundPoints.values()].reduce((sum, p) => sum + p, 0);

    standings.push({
      teamId,
      teamName: team.name,
      logoUrl: resolveTeamLogo(team, season.id, seasonLogoMap),
      totalPoints,
      starts: a.starts,
      appearances: a.subsessionIds.size,
      driverIds: [...a.driverIds],
    });
  }

  standings.sort((a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName));
  return standings.map((s, i) => ({ ...s, position: i + 1 }));
}

// ---------------------------------------------------------------------------
// Season driver "extended stats" — powers the Standings page's expandable
// per-driver detail panel. Deliberately view-agnostic (computed once from
// every class combined, via getSeasonOverallContext) rather than split
// per-class/overall like DriverSeasonStanding — a driver only ever races in
// one class in a given season, so "how many laps did they turn this season"
// isn't a different number depending on which standings view is open.
// ---------------------------------------------------------------------------

export interface DriverSeasonExtendedStats {
  laps: number;
  lapsLed: number;
  /** Sum of (starting position − final position) across every race this season — positive means net positions gained, negative means net lost. Uses the same penalty-adjusted final position (`adjusted_position` falling back to `finish_position`) as everywhere else in this file. */
  netPositionsChange: number;
  incidents: number;
  /** null when `laps` is 0 (nothing to divide by) rather than showing a misleading 0. */
  incidentsPerLap: number | null;
  /** Season total penalty points (PP) — sums every logged penalty's effective (appeal-aware) PP against this driver, same figure `effectivePenaltyPoints` produces everywhere else (rule 57's season PP limit). NOT the same thing as a race's `points_deduction` (that's the points-scoring effect of a penalty, already folded into totalPoints) — this is the separate PP counter. */
  penaltyPoints: number;
  /**
   * Season total finesse + pole bonus points earned — deliberately excludes
   * Gamma/Delta's own class_points bonus, matching computeOverallSeasonStandings'
   * own reasoning for leaving class_points out of the "overall" competition
   * (it's each of those classes' own per-race class-position bonus, not
   * something every driver can earn). A Gamma/Delta driver's own class_points
   * total isn't reflected here.
   */
  bonusPoints: number;
  /** Total km driven this season (laps completed × that round's matched circuit-layout length), or null if not even one of this driver's rounds could be matched to a circuit_layouts row — see resolveLayout. When only SOME rounds match, this is a lower bound (the unmatched rounds' laps are simply not counted) rather than null, so a driver with mostly-tracked rounds still shows a useful (if slightly conservative) figure. */
  distanceKm: number | null;
  /** Total corners navigated this season (laps completed × that round's matched layout's `corners`) divided by total incidents — "how many corners on average between incidents," a finer-grained version of incidentsPerLap. Null whenever it can't be computed cleanly: no round resolved to a layout with a corner count on file (see 0022_circuit_layout_corners.sql — many layouts won't have one yet), or this driver had 0 incidents (an undefined/infinite ratio, not a real number to show). Like distanceKm, a driver with only some rounds resolving to a corner count still gets a (conservative) figure from the ones that did. */
  cornersPerIncident: number | null;
  /** The raw numerator behind `cornersPerIncident` (corners navigated, not divided by incidents yet) — null under the same "nothing resolved" condition `cornersPerIncident` uses (NOT null just because incidents was 0, unlike that field — a career-stats aggregator summing this across seasons needs the real total, and dividing by a separately-summed incident count itself, to get a mathematically correct career CPI rather than an average of season ratios). See computeDriverCareerStats. */
  totalCorners: number | null;
}

function normalizeTrackOrLayoutName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves a round's `track_name` + `curated_rounds.layout` column to one
 * `circuit_layouts` row — a minimal, standalone re-derivation of
 * newsRecap.ts's own `matchCircuitLayout` (same direct/normalized matching
 * rules; see that function's doc comment for the full reasoning), duplicated
 * here rather than imported since newsRecap.ts already imports FROM this
 * file (getRoundBySubsessionId, getRoundResults, topTeamScorers) —
 * importing back the other way would create a cycle. Only the resolved row
 * is needed here (not newsRecap's admin-facing "issue" text), so this
 * version just returns null on anything it can't resolve to exactly one
 * layout. Callers pull whichever field(s) they need off the result
 * (length_km for distance driven, corners for corners-per-incident) — kept
 * as one shared resolution rather than two separate functions since it's
 * the exact same matching logic either way.
 */
function resolveLayout(
  trackName: string,
  roundLayout: string | null,
  circuits: Circuit[],
  layouts: CircuitLayout[]
): CircuitLayout | null {
  const targetTrack = normalizeTrackOrLayoutName(trackName);
  const circuit = circuits.find((c) => normalizeTrackOrLayoutName(c.name) === targetTrack);
  if (!circuit) return null;
  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuit.id);
  if (circuitLayouts.length === 0) return null;
  if (circuitLayouts.length === 1) return circuitLayouts[0];
  if (!roundLayout) return null;
  const targetLayout = normalizeTrackOrLayoutName(roundLayout);
  return circuitLayouts.find((l) => normalizeTrackOrLayoutName(l.name) === targetLayout) ?? null;
}

/**
 * Every historical round ever run at one specific circuit_layouts row,
 * newest first — powers the event list's "Race Recaps at this Layout"
 * collapsible (src/components/EventDetailCard.astro). Pure/no network calls
 * itself: `allRounds` and `roundLayoutBySubsession` are meant to be fetched
 * ONCE per page (getAllRounds() + getRoundLayoutsForSubsessions()) and
 * reused across every event card on that page, same "bulk fetch once, slice
 * in memory per card" reasoning as computeDriverCareerStats — a calendar
 * page can show many events, several of which may repeat the same circuit,
 * so resolving this per-card with its own fetches would multiply query
 * count by the number of cards shown.
 *
 * The actual recap CONTENT (top finishers, fastest lap, etc.) is
 * deliberately NOT computed here — that's the expensive part
 * (computeRoundRecap, ~8 queries per round), and eagerly running it for
 * every matching round of every event card could easily blow through
 * Cloudflare Workers' subrequest limit on a calendar with any history at
 * all (see README's homepage-widget incident for exactly this class of
 * bug). Callers fetch each round's recap lazily, client-side, only once a
 * visitor actually expands it — see src/pages/api/round-recap/[subsessionId].ts
 * and src/scripts/roundRecap.ts.
 */
export interface LayoutRoundSummary {
  subsessionId: number;
  trackName: string;
  startTime: string;
  seasonLabel: string | null;
}

function resolveEventLayoutId(circuitId: string, eventLayoutName: string | null, layouts: CircuitLayout[]): string | null {
  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuitId);
  if (circuitLayouts.length === 0) return null;
  if (circuitLayouts.length === 1) return circuitLayouts[0].id;
  if (!eventLayoutName) return null;
  const targetLayout = normalizeTrackOrLayoutName(eventLayoutName);
  return circuitLayouts.find((l) => normalizeTrackOrLayoutName(l.name) === targetLayout)?.id ?? null;
}

export function findRoundsForLayout(
  allRounds: RoundSummary[],
  roundLayoutBySubsession: Map<number, string | null>,
  circuits: Circuit[],
  layouts: CircuitLayout[],
  circuitId: string,
  eventLayoutName: string | null
): LayoutRoundSummary[] {
  const targetLayoutId = resolveEventLayoutId(circuitId, eventLayoutName, layouts);
  if (!targetLayoutId) return [];

  const matches = allRounds.filter((r) => {
    const resolved = resolveLayout(r.track_name, roundLayoutBySubsession.get(r.subsession_id) ?? null, circuits, layouts);
    return resolved?.id === targetLayoutId;
  });

  return matches
    .sort((a, b) => b.start_time.localeCompare(a.start_time))
    .map((r) => ({ subsessionId: r.subsession_id, trackName: r.track_name, startTime: r.start_time, seasonLabel: r.season_label }));
}

/** Batched version of newsRecap.ts's fetchRoundLayout — one query for every round in the season instead of one per round. Same graceful-degradation-on-failure reasoning (this is a small admin-filled column that may not exist/be filled in for every round). */
export async function getRoundLayoutsForSubsessions(env: SupabaseEnv, subsessionIds: number[]): Promise<Map<number, string | null>> {
  if (subsessionIds.length === 0) return new Map();
  try {
    // restGetAll — same reasoning as getCuratedRaceResultsForSubsessions;
    // a whole-career call can pass hundreds of subsession_ids at once.
    // subsession_id alone is unique here (one curated_rounds row per
    // round), so it's also a sufficient stable sort for pagination.
    const rows = await restGetAll<{ subsession_id: number; layout: string | null }>(
      env,
      `curated_rounds?select=subsession_id,layout&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc`
    );
    return new Map(rows.map((r) => [r.subsession_id, r.layout]));
  } catch (err) {
    console.error('Failed to fetch curated_rounds.layout for season distance-driven stats — distance will be omitted:', err);
    return new Map();
  }
}

/**
 * Combines `getCuratedRaceResultsForSubsessions`' columns with
 * `getLapStatsForSubsessions`' two extra ones into ONE query — for
 * `computeDriverCareerStats`' bulk path only. Every other caller keeps
 * using the two separate, isolated queries (see `getLapStatsForSubsessions`'
 * own doc comment for why they're isolated: an unverified column failing
 * shouldn't be able to take down the main results/standings pipeline). A
 * whole-career computation already issues several large paginated queries;
 * merging these two identical-scope ones into one, just for this path,
 * roughly halves that particular cost. Falls back to running the two
 * separate (still safely isolated) queries if the combined one fails for
 * any reason — e.g. those two columns genuinely missing on some
 * deployment — so this never makes career stats less resilient than
 * before, only faster in the common case.
 */
async function getCuratedRaceResultsWithLapStatsBulk(
  env: SupabaseEnv,
  subsessionIds: number[]
): Promise<{ rawResults: CuratedRaceResultRow[]; lapStats: RawLapStatsRow[] }> {
  if (subsessionIds.length === 0) return { rawResults: [], lapStats: [] };
  const combinedSelect =
    'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,laps_led,car_name,interval_ten_thousandths,average_lap_ten_thousandths,best_lap_ten_thousandths';
  try {
    const rows = await restGetAll<CuratedRaceResultRow & RawLapStatsRow>(
      env,
      `curated_race_results?select=${combinedSelect}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`
    );
    return { rawResults: rows, lapStats: rows };
  } catch (err) {
    console.error(
      'Combined curated_race_results+lap-stats bulk query failed — falling back to the two separate isolated queries:',
      err
    );
    const [rawResults, lapStats] = await Promise.all([
      getCuratedRaceResultsForSubsessions(env, subsessionIds),
      getLapStatsForSubsessions(env, subsessionIds),
    ]);
    return { rawResults, lapStats };
  }
}

/**
 * Per-driver season totals for the Standings page's expandable detail panel
 * — laps, laps led, net positions gained/lost, incidents/incidents-per-lap,
 * season penalty points, bonus points, and distance driven. See
 * `DriverSeasonExtendedStats`' own field comments for exactly what each
 * figure includes/excludes.
 */
export async function getSeasonDriverExtendedStats(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>,
  driversBasic?: DriverBasic[],
  /** See `computeSeasonStandings`' identical param. */
  precomputedOverallContext?: SeasonOverallContext,
  /** `circuits`/`circuit_layouts` aren't season-scoped at all — every season's distance/corners math resolves against the exact same global list, so a caller computing this for many seasons (`computeDriverCareerStats`) should fetch these ONCE for the whole run rather than once per season. */
  circuitsLookup?: Circuit[],
  layoutsLookup?: CircuitLayout[],
  /** `curated_rounds.layout` for every subsession this call might touch, pre-fetched — see `circuitsLookup`'s reasoning. Must cover at least this season's own subsessions; a caller with a global map covering every season (`computeDriverCareerStats`) can just pass the same one to every season's call. */
  roundLayoutsLookup?: Map<number, string | null>
): Promise<Map<string, DriverSeasonExtendedStats>> {
  if (!isChampionshipSeason(season.name)) return new Map();

  const [drivers, exhibitionIds] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
  ]);

  const overallContext = precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  const scores = overallContext.overallScores;
  if (scores.length === 0) return new Map();

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
  const [circuits, layouts, roundLayouts] = await Promise.all([
    circuitsLookup
      ? Promise.resolve(circuitsLookup)
      : getCircuits(env).catch((err) => {
          console.error('Failed to fetch circuits for season distance-driven/corners-per-incident stats — both will be omitted:', err);
          return [] as Circuit[];
        }),
    layoutsLookup
      ? Promise.resolve(layoutsLookup)
      : getAllCircuitLayouts(env).catch((err) => {
          console.error('Failed to fetch circuit_layouts for season distance-driven/corners-per-incident stats — both will be omitted:', err);
          return [] as CircuitLayout[];
        }),
    roundLayoutsLookup ? Promise.resolve(roundLayoutsLookup) : getRoundLayoutsForSubsessions(env, subsessionIds),
  ]);
  // seasonRounds comes straight off the shared context now (same
  // curated_rounds fetch getSeasonOverallContext already made for
  // formatBySubsession) instead of a second getRoundsForSeason call.
  const trackNameBySubsession = new Map(overallContext.seasonRounds.map((r) => [r.subsession_id, r.track_name]));
  const kmBySubsession = new Map<number, number | null>();
  const cornersBySubsession = new Map<number, number | null>();
  for (const subsessionId of subsessionIds) {
    const trackName = trackNameBySubsession.get(subsessionId);
    const layout = trackName ? resolveLayout(trackName, roundLayouts.get(subsessionId) ?? null, circuits, layouts) : null;
    kmBySubsession.set(subsessionId, layout?.length_km ?? null);
    cornersBySubsession.set(subsessionId, layout?.corners ?? null);
  }

  interface ExtendedAccum {
    laps: number;
    lapsLed: number;
    netPositionsChange: number;
    incidents: number;
    penaltyPoints: number;
    bonusPoints: number;
    distanceKm: number;
    totalCorners: number;
  }
  const accum = new Map<string, ExtendedAccum>();
  function getAccum(driverId: string): ExtendedAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = { laps: 0, lapsLed: 0, netPositionsChange: 0, incidents: 0, penaltyPoints: 0, bonusPoints: 0, distanceKm: 0, totalCorners: 0 };
      accum.set(driverId, a);
    }
    return a;
  }

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.bonusPoints += s.finesse_bonus + s.pole_bonus;

    const custId = overallContext.custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? overallContext.rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    if (!raw) continue;
    a.laps += raw.laps_complete ?? 0;
    a.lapsLed += raw.laps_led ?? 0;
    a.incidents += raw.incidents ?? 0;

    const finalPosition = raw.adjusted_position ?? raw.finish_position;
    if (raw.starting_position !== null && finalPosition !== null) {
      a.netPositionsChange += raw.starting_position - finalPosition;
    }

    const km = kmBySubsession.get(s.subsession_id);
    if (km !== null && km !== undefined) a.distanceKm += (raw.laps_complete ?? 0) * km;

    const corners = cornersBySubsession.get(s.subsession_id);
    if (corners !== null && corners !== undefined) a.totalCorners += (raw.laps_complete ?? 0) * corners;
  }

  // Season penalty points (PP) — separate loop since penalties aren't
  // per-(subsession,race,driver)-in-`scores`, they're their own table.
  for (const p of overallContext.penalties) {
    if (!p.driver_id) continue;
    const a = getAccum(p.driver_id);
    a.penaltyPoints += effectivePenaltyPoints(p);
  }

  // Whether at least one of this driver's rounds actually resolved to a
  // known circuit length/corner count — distinguishes "0 because nothing
  // matched" (show as unavailable) from "0 because they didn't drive" (show
  // as 0).
  const anyKmResolvedByDriver = new Map<string, boolean>();
  const anyCornersResolvedByDriver = new Map<string, boolean>();
  for (const s of scores) {
    const km = kmBySubsession.get(s.subsession_id);
    if (km !== null && km !== undefined) anyKmResolvedByDriver.set(s.driver_id, true);
    const corners = cornersBySubsession.get(s.subsession_id);
    if (corners !== null && corners !== undefined) anyCornersResolvedByDriver.set(s.driver_id, true);
  }

  const out = new Map<string, DriverSeasonExtendedStats>();
  for (const [driverId, a] of accum) {
    const hasCorners = anyCornersResolvedByDriver.get(driverId) === true;
    out.set(driverId, {
      laps: a.laps,
      lapsLed: a.lapsLed,
      netPositionsChange: a.netPositionsChange,
      incidents: a.incidents,
      incidentsPerLap: a.laps > 0 ? a.incidents / a.laps : null,
      penaltyPoints: a.penaltyPoints,
      bonusPoints: a.bonusPoints,
      distanceKm: anyKmResolvedByDriver.get(driverId) ? a.distanceKm : null,
      cornersPerIncident: hasCorners && a.incidents > 0 ? a.totalCorners / a.incidents : null,
      totalCorners: hasCorners ? a.totalCorners : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-driver car/team usage for a season — powers the small logo rows on
// the standings page (see src/pages/standings.astro).
// ---------------------------------------------------------------------------

export interface DriverCarStat {
  carName: string;
  logoUrl: string | null;
  races: number;
}

export interface DriverTeamStat {
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  /** How many races this driver raced under this team, this season. */
  racesUnderTeam: number;
  /**
   * How many of those races this driver was one of the team's top 2 point
   * scorers in (the rule that decides which drivers' points actually count
   * toward the team championship for that race).
   */
  racesScoredForTeam: number;
}

export interface DriverSeasonExtras {
  cars: DriverCarStat[];
  teams: DriverTeamStat[];
}

/**
 * Ranks same-team, same-race rows by points and keeps just the top 2 —
 * Logan's team championship rule: "only the top 2 scoring drivers for each
 * team add their points to the team championship per race." The single
 * source of truth for this rule; every place that needs "who scored for
 * this team this race" (season car/team usage stats, the news recap's team
 * breakdown, Team Standings) calls this instead of re-deriving it.
 *
 * `pointsOf` lets each caller pick which points figure to rank (and
 * presumably then sum) by — the cross-class "overall" team competition
 * uses the class-blind formula (finish + finesse + pole + deduction,
 * matching `computeOverallSeasonStandings`' own formula), while a single
 * class's own team competition (e.g. Delta's) wants that class's full
 * total, class_points bonus included.
 */
export function topTeamScorers<T>(rows: T[], pointsOf: (row: T) => number): T[] {
  return [...rows].sort((a, b) => pointsOf(b) - pointsOf(a)).slice(0, 2);
}

/**
 * Per-driver "which cars/teams did they use this season, how often" —
 * computed once for the whole season (every class, regardless of which
 * standings view — overall or per-class — is actually being shown), since
 * a driver's car/team usage isn't itself a per-class-view concern.
 *
 * Team `racesScoredForTeam` implements `topTeamScorers()`'s rule (see its
 * own doc comment) for every (race, team) group.
 */
export async function getSeasonCarTeamStats(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>,
  driversBasic?: DriverBasic[],
  teamsBasic?: TeamBasic[],
  carLogosLookup?: CarLogo[],
  seasonLogoRowsParam?: { team_id: string; season_id: string; logo_url: string }[],
  /**
   * When given, skips this function's own race_scores/curated_race_results
   * fetches entirely and reuses this season-wide context's
   * `overallScores`/`rawByKey` instead — see `computeSeasonStandings`'
   * identical param. Omit it (every existing single-season caller does) and
   * this function fetches its own smaller, cheaper pair of queries exactly
   * as before; pulling in the FULL context (penalties, lap stats,
   * curated_rounds) unconditionally would cost those callers MORE, not
   * less, since this function doesn't use any of that extra data itself.
   */
  precomputedOverallContext?: SeasonOverallContext
): Promise<Map<string, DriverSeasonExtras>> {
  const [drivers, teams, carLogos, exhibitionIds, seasonLogoRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    teamsBasic ? Promise.resolve(teamsBasic) : getTeamsBasic(env),
    carLogosLookup ? Promise.resolve(carLogosLookup) : getCarLogos(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
    seasonLogoRowsParam ? Promise.resolve(seasonLogoRowsParam) : getAllTeamSeasonLogosSafe(env),
  ]);

  let scores: RaceScoreOverallRow[];
  let carNameByKey: Map<string, string | null>;
  if (precomputedOverallContext) {
    scores = precomputedOverallContext.overallScores;
    carNameByKey = new Map(
      [...precomputedOverallContext.rawByKey.values()].map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r.car_name])
    );
  } else {
    const scoresRaw = await getRaceScoresForSeasonOverall(env, season.id);
    scores = exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
    const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
    const rawResults = await getCuratedRaceResultsForSubsessions(env, subsessionIds);
    carNameByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r.car_name]));
  }
  if (scores.length === 0) return new Map();
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));

  // --- Cars: tally per-driver usage, one count per race started in that car. ---
  const carCountsByDriver = new Map<string, Map<string, number>>();
  for (const s of scores) {
    const custId = custIdByDriverId.get(s.driver_id);
    const carName = custId != null ? carNameByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    if (!carName) continue;
    if (!carCountsByDriver.has(s.driver_id)) carCountsByDriver.set(s.driver_id, new Map());
    const m = carCountsByDriver.get(s.driver_id)!;
    m.set(carName, (m.get(carName) ?? 0) + 1);
  }

  // --- Teams: tally races raced under each team, and figure out who was
  // one of the top 2 scorers for their team in each individual race. ---
  const racesUnderByDriverTeam = new Map<string, Map<string, number>>(); // driverId -> teamId -> count
  const teamRaceGroups = new Map<string, RaceScoreOverallRow[]>(); // "subsession:race:team" -> that team's rows for that race
  for (const s of scores) {
    if (!s.team_id) continue;
    if (!racesUnderByDriverTeam.has(s.driver_id)) racesUnderByDriverTeam.set(s.driver_id, new Map());
    const m = racesUnderByDriverTeam.get(s.driver_id)!;
    m.set(s.team_id, (m.get(s.team_id) ?? 0) + 1);

    const key = `${s.subsession_id}:${s.race_number}:${s.team_id}`;
    if (!teamRaceGroups.has(key)) teamRaceGroups.set(key, []);
    teamRaceGroups.get(key)!.push(s);
  }

  const scoredForTeamByDriverTeam = new Map<string, Map<string, number>>(); // driverId -> teamId -> count
  const overallPointsOf = (s: RaceScoreOverallRow) => s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
  for (const group of teamRaceGroups.values()) {
    for (const s of topTeamScorers(group, overallPointsOf)) {
      if (!scoredForTeamByDriverTeam.has(s.driver_id)) scoredForTeamByDriverTeam.set(s.driver_id, new Map());
      const m = scoredForTeamByDriverTeam.get(s.driver_id)!;
      m.set(s.team_id as string, (m.get(s.team_id as string) ?? 0) + 1);
    }
  }

  const out = new Map<string, DriverSeasonExtras>();
  const driverIds = new Set([...carCountsByDriver.keys(), ...racesUnderByDriverTeam.keys()]);
  for (const driverId of driverIds) {
    const cars: DriverCarStat[] = [...(carCountsByDriver.get(driverId)?.entries() ?? [])]
      .map(([carName, races]) => ({ carName, logoUrl: carLogoByName.get(carName) ?? null, races }))
      .sort((a, b) => b.races - a.races);

    const teamsForDriver = racesUnderByDriverTeam.get(driverId);
    const teamsOut: DriverTeamStat[] = teamsForDriver
      ? [...teamsForDriver.entries()]
          .map(([teamId, racesUnderTeam]) => {
            const team = teamById.get(teamId);
            return {
              teamId,
              teamName: team?.name ?? 'Unknown Team',
              logoUrl: team ? resolveTeamLogo(team, season.id, seasonLogoMap) : null,
              racesUnderTeam,
              racesScoredForTeam: scoredForTeamByDriverTeam.get(driverId)?.get(teamId) ?? 0,
            };
          })
          .sort((a, b) => b.racesUnderTeam - a.racesUnderTeam)
      : [];

    out.set(driverId, { cars, teams: teamsOut });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Champions — the #1 standing for every season a class actually raced in
// ---------------------------------------------------------------------------

export interface ChampionEntry {
  season: Season;
  standing: DriverSeasonStanding;
}

/**
 * One entry per season the given class has any race_scores data for,
 * newest season first. Seasons before a class existed (Delta before ATC5,
 * Gamma before ATC16) simply have no rows and are skipped automatically —
 * no hardcoded season cutoffs needed.
 */
export async function getChampions(env: SupabaseEnv, seasons: Season[], classId: number): Promise<ChampionEntry[]> {
  const championshipSeasons = seasons.filter((s) => isChampionshipSeason(s.name));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  // Same "bulk-fetch once across every season, then slice in memory" fix
  // computeDriverCareerStats needed for the exact same reason (see that
  // function's own doc comment) — this used to call computeSeasonStandings
  // once per season with nothing precomputed, so each of computeSeasonStandings'
  // own several queries multiplied by every season on file, blowing straight
  // through Cloudflare Workers' per-request subrequest limit ("Too many
  // subrequests by single Worker invocation") once there were more than a
  // handful of seasons — exactly what broke Admin > Champions and the public
  // Champions page.
  const [drivers, exhibitionIds, classes, bulkScores, allRounds] = await Promise.all([
    driversSelect(env),
    getExhibitionRoundIds(env),
    getDriverClasses(env),
    getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
    getAllRounds(env),
  ]);

  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
  ]);

  const perSeason = await Promise.all(
    championshipSeasons.map(async (season) => {
      // Pure in-memory filtering from here down — no network calls inside
      // this per-season loop, same as computeDriverCareerStats.
      const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
      if (seasonScores.length === 0) return null;
      const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
      const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
      const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

      const overallContext = buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        seasonScores,
        seasonRawResults,
        seasonPenalties,
        seasonRounds,
        seasonLapStats
      );

      const classScores = seasonScores.filter((s) => s.class_id === classId);
      const standings = await computeSeasonStandings(
        env,
        season,
        classId,
        drivers,
        exhibitionIds,
        classes,
        overallContext,
        classScores
      );
      return standings.length > 0 ? { season, standing: standings[0] } : null;
    })
  );
  return perSeason.filter((r): r is ChampionEntry => r !== null);
}

// ---------------------------------------------------------------------------
// Career driver stats — every driver who has ever scored in a championship
// season, with career totals summed across every class and season they've
// raced, plus a season-by-season breakdown. Powers the "Driver Stats"
// history tab (src/pages/driver-stats.astro).
//
// Nothing here is stored — like getChampions, it's fully recomputed by
// looping every championship season (and, within each, every class), so a
// driver who just got their first race_scores rows shows up automatically
// on the very next page load, with no separate "add them to career stats"
// step anywhere in the app.
// ---------------------------------------------------------------------------

/** One driver's stat line for one season (they raced exactly one class in a season, so this is also effectively "one class" — the class is carried on the row for display/grouping, not because a driver could have two rows in the same season). */
export interface DriverCareerSeasonRow {
  season: Season;
  classId: number;
  className: string;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  starts: number;
  appearances: number;
  laps: number;
  lapsLed: number;
  incidents: number;
  /** Null under the same "nothing resolved to a layout with a corner count" condition DriverSeasonExtendedStats.totalCorners uses — see that field's own doc comment. */
  totalCorners: number | null;
  /** This driver's position in that season's class standings — 1 means they won that class's championship that season. */
  classPosition: number;
  /** This driver's position in that season's cross-class Overall driver standings. Null only if they somehow don't appear there despite having class_scores rows — shouldn't normally happen. */
  overallPosition: number | null;
  /** The overall (cross-class) Team Standings position of this driver's PRIMARY team that season (the team they raced under most, when they raced under more than one — see `teams` below for the full breakdown) — null if they had no team that season. */
  teamPosition: number | null;
  /** Same idea, but the Delta-only team competition's position for that same primary team — null if they had no team, or their team didn't score in the Delta competition that season (e.g. no Delta driver on the team, or this driver's own class isn't Delta and no teammate raced Delta either). */
  deltaTeamPosition: number | null;
  cars: DriverCarStat[];
  teams: DriverTeamStat[];
}

export interface DriverCareerStats {
  driver: DriverBasic;
  /** Count of seasons this driver finished 1st in their class's standings — summed across every class they've ever raced, not just their current one. */
  championships: number;
  wins: number;
  podiums: number;
  poles: number;
  top5s: number;
  top10s: number;
  laps: number;
  lapsLed: number;
  starts: number;
  appearances: number;
  /** Career-wide corners-per-incident — deliberately NOT an average of each season's own cornersPerIncident (that would over-weight low-incident seasons); it's total corners navigated across every season that resolved a corner count, divided by total incidents across the WHOLE career. Null under the same "nothing to compute from" conditions the per-season figure uses. */
  cornersPerIncident: number | null;
  /** Newest season first — same ordering the Champions/Standings pages use. */
  seasons: DriverCareerSeasonRow[];
}

/**
 * Rolls a set of a driver's own season rows up into one career stat line —
 * pure aggregation, no fetching. `computeDriverCareerStats` calls this once
 * per driver with ALL of that driver's season rows (their whole career,
 * every class); the Driver Stats page's per-class filters (src/pages/
 * driver-stats.astro) call it again per driver with just the season rows
 * matching one class, so a driver's "Alpha" tab line reflects only their
 * time actually racing Alpha — same shape, same math, just a narrower
 * input. Caller is responsible for deciding which rows to include (and for
 * skipping a driver entirely if the filtered set comes back empty).
 */
export function aggregateDriverCareerStats(driver: DriverBasic, seasonRows: DriverCareerSeasonRow[]): DriverCareerStats {
  let championships = 0;
  let wins = 0;
  let podiums = 0;
  let poles = 0;
  let top5s = 0;
  let top10s = 0;
  let laps = 0;
  let lapsLed = 0;
  let starts = 0;
  let appearances = 0;
  let totalCorners = 0;
  let totalIncidents = 0;
  let anyCornersResolved = false;

  for (const r of seasonRows) {
    if (r.classPosition === 1) championships++;
    wins += r.wins;
    podiums += r.podiums;
    poles += r.poles;
    top5s += r.top5s;
    top10s += r.top10s;
    laps += r.laps;
    lapsLed += r.lapsLed;
    starts += r.starts;
    appearances += r.appearances;
    totalIncidents += r.incidents;
    if (r.totalCorners !== null) {
      totalCorners += r.totalCorners;
      anyCornersResolved = true;
    }
  }

  return {
    driver,
    championships,
    wins,
    podiums,
    poles,
    top5s,
    top10s,
    laps,
    lapsLed,
    starts,
    appearances,
    cornersPerIncident: anyCornersResolved && totalIncidents > 0 ? totalCorners / totalIncidents : null,
    seasons: seasonRows,
  };
}

/**
 * Computes every driver's full career stat line. Loops every championship
 * season (exhibition seasons are excluded from all statistics, per
 * `isChampionshipSeason`'s own doc comment) and, within each, every driver
 * class, running the exact same per-season computations the Champions/
 * Standings/Team Standings pages already use — this is purely an
 * aggregation on top of those, not a new scoring engine.
 */
export async function computeDriverCareerStats(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>
): Promise<DriverCareerStats[]> {
  const championshipSeasons = seasons.filter((s) => isChampionshipSeason(s.name));
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  // Every one of these is fetched exactly ONCE for this whole career
  // computation — not once per season, not once per class — and then
  // sliced/filtered per season entirely in memory below (no network calls
  // at all inside the per-season loop). An earlier version of this
  // function shared each season's context ACROSS that season's several
  // computations, but still fetched that shared context once PER SEASON —
  // looping N seasons through even one shared fetch each still summed to
  // more subrequests than Cloudflare Workers allows per request ("Too many
  // subrequests by single Worker invocation") once there were more than a
  // handful of seasons on file. The only fix that stays flat no matter how
  // many seasons get added in the future is to never issue a query "per
  // season" at all — bulk-fetch across every season once, then filter.
  const [drivers, exhibitionIds, teams, carLogos, seasonLogoRows, circuits, layouts, bulkScores, allRounds] = await Promise.all([
    driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
    getTeamsBasic(env),
    getCarLogos(env),
    getAllTeamSeasonLogosSafe(env),
    getCircuits(env).catch((err) => {
      console.error('Failed to fetch circuits for career distance/corners-per-incident stats — both will be omitted:', err);
      return [] as Circuit[];
    }),
    getAllCircuitLayouts(env).catch((err) => {
      console.error('Failed to fetch circuit_layouts for career distance/corners-per-incident stats — both will be omitted:', err);
      return [] as CircuitLayout[];
    }),
    getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
    getAllRounds(env),
  ]);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  // Delta runs its own separate team competition (see computeTeamSeasonStandings'
  // own doc comment) — every other class's drivers just show "—" for
  // deltaTeamPosition unless their team happens to also field a Delta driver.
  const deltaClass = classes.find((c) => c.name === 'Delta');

  // The one remaining set of per-subsession queries (curated_race_results,
  // penalties, average/best lap data, curated_rounds.layout) — each run
  // ONCE across the union of every subsession any championship season's
  // race_scores rows touch, instead of once per season.
  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties, roundLayouts] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
    getRoundLayoutsForSubsessions(env, allSubsessionIds),
  ]);

  const seasonRowsByDriver = new Map<string, DriverCareerSeasonRow[]>();

  for (const season of championshipSeasons) {
    // Slice this whole run's bulk fetches down to just this season — pure
    // in-memory filtering (a subsession only ever belongs to one season),
    // no network calls anywhere in this loop.
    const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
    if (seasonScores.length === 0) continue;
    const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
    const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
    const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
    const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
    const seasonRounds = allRounds.filter((r) => r.season_id === season.id);

    // Same context every single-season page builds via getSeasonOverallContext
    // — built directly here (no fetch) since every ingredient is already an
    // in-memory slice of this run's bulk fetches.
    const overallContext = buildSeasonOverallContext(
      exhibitionIds,
      drivers,
      seasonScores,
      seasonRawResults,
      seasonPenalties,
      seasonRounds,
      seasonLapStats
    );

    const scoresByClassId = new Map<number, RaceScoreRow[]>();
    for (const row of seasonScores) {
      if (!scoresByClassId.has(row.class_id)) scoresByClassId.set(row.class_id, []);
      scoresByClassId.get(row.class_id)!.push(row);
    }

    const [classStandingsByClass, overallStandings, extendedStats, teamStandingsOverall, teamStandingsDelta, carTeamStats] =
      await Promise.all([
        Promise.all(
          classes.map((c) =>
            computeSeasonStandings(
              env,
              season,
              c.id,
              drivers,
              exhibitionIds,
              classes,
              overallContext,
              scoresByClassId.get(c.id) ?? []
            )
          )
        ),
        computeOverallSeasonStandings(env, season, drivers, exhibitionIds, overallContext),
        getSeasonDriverExtendedStats(env, season, exhibitionIds, drivers, overallContext, circuits, layouts, roundLayouts),
        computeTeamSeasonStandings(env, season, exhibitionIds, undefined, drivers, teams, seasonLogoRows, classes, overallContext),
        deltaClass
          ? computeTeamSeasonStandings(
              env,
              season,
              exhibitionIds,
              deltaClass.id,
              drivers,
              teams,
              seasonLogoRows,
              classes,
              overallContext,
              scoresByClassId.get(deltaClass.id) ?? []
            )
          : Promise.resolve([]),
        getSeasonCarTeamStats(env, season, exhibitionIds, drivers, teams, carLogos, seasonLogoRows, overallContext),
      ]);

    const overallPositionByDriverId = new Map(overallStandings.map((s) => [s.driver.id, s.position]));
      const teamPositionByTeamId = new Map(teamStandingsOverall.map((t) => [t.teamId, t.position]));
      const deltaTeamPositionByTeamId = new Map(teamStandingsDelta.map((t) => [t.teamId, t.position]));

      classes.forEach((cls, i) => {
        for (const standing of classStandingsByClass[i]) {
          const driverId = standing.driver.id;
          const extras = carTeamStats.get(driverId);
          const ext = extendedStats.get(driverId);
          // getSeasonCarTeamStats already sorts a driver's teams by
          // racesUnderTeam descending — [0] is their primary team that
          // season (the only one relevant for "their team's standing").
          const primaryTeam = extras?.teams[0] ?? null;

          const row: DriverCareerSeasonRow = {
            season,
            classId: cls.id,
            className: cls.name,
            wins: standing.wins,
            podiums: standing.podiums,
            top5s: standing.top5s,
            top10s: standing.top10s,
            poles: standing.poles,
            starts: standing.starts,
            appearances: standing.appearances,
            laps: standing.laps,
            lapsLed: standing.lapsLed,
            incidents: ext?.incidents ?? 0,
            totalCorners: ext?.totalCorners ?? null,
            classPosition: standing.position,
            overallPosition: overallPositionByDriverId.get(driverId) ?? null,
            teamPosition: primaryTeam ? teamPositionByTeamId.get(primaryTeam.teamId) ?? null : null,
            deltaTeamPosition: primaryTeam ? deltaTeamPositionByTeamId.get(primaryTeam.teamId) ?? null : null,
            cars: extras?.cars ?? [],
            teams: extras?.teams ?? [],
          };

          if (!seasonRowsByDriver.has(driverId)) seasonRowsByDriver.set(driverId, []);
          seasonRowsByDriver.get(driverId)!.push(row);
        }
      });
  }

  const out: DriverCareerStats[] = [];
  for (const [driverId, seasonRows] of seasonRowsByDriver) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    seasonRows.sort((a, b) => b.season.number - a.season.number);
    out.push(aggregateDriverCareerStats(driver, seasonRows));
  }

  out.sort((a, b) => displayDriverName(a.driver.name).localeCompare(displayDriverName(b.driver.name)));
  return out;
}

// ---------------------------------------------------------------------------
// Career team stats — every team that has ever fielded a driver, with
// career totals and a season-by-season breakdown. Powers the "Team Stats"
// history tab (src/pages/team-stats.astro).
//
// Deliberately NOT a second whole-history computation — it's a pure
// in-memory pivot of computeDriverCareerStats' own output (issues zero
// extra Supabase queries), attributing each driver-season's stat line to
// that driver's PRIMARY team that season (DriverCareerSeasonRow.teams[0] —
// same "primary team" a driver's own Team Pos/Delta Team Pos columns
// already use). A driver with no team that season contributes to no team's
// totals. This intentionally rolls up individual results rather than
// re-deriving team-level wins/podiums/etc. from scratch, since this site's
// team championship (see computeTeamSeasonStandings) only ever scores
// POINTS at the team level (top-2-scorers-per-race) — there's no separate
// notion of a "team win" or "team pole" independent of its drivers' own
// results to compute in the first place.
// ---------------------------------------------------------------------------

export interface TeamCareerSeasonDriver {
  driverId: string;
  name: string;
  carNumber: number | null;
  className: string;
  starts: number;
  nationality1: string | null;
  nationality2: string | null;
}

/** One team's stat line for one season, rolled up from every driver whose PRIMARY team that season was this one. */
export interface TeamCareerSeasonRow {
  season: Season;
  /** This team's position in that season's cross-class Overall Team Standings — 1 means they won the team championship that season. Null if, unusually, they had a primary-team driver but never appear there (shouldn't normally happen). */
  teamPosition: number | null;
  /** Same idea, the Delta-only team competition's position — null if not applicable (see DriverCareerSeasonRow.deltaTeamPosition's own doc comment). */
  deltaTeamPosition: number | null;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  starts: number;
  appearances: number;
  laps: number;
  lapsLed: number;
  incidents: number;
  totalCorners: number | null;
  /** This team's roster that season (every driver whose primary team it was), most races first — a team can span multiple classes at once, so this carries each driver's own class rather than the row having one. */
  drivers: TeamCareerSeasonDriver[];
}

export interface TeamCareerStats {
  teamId: string;
  teamName: string;
  /** From the most recent season this team fielded a primary-team driver — teams don't have a single fixed logo (see 0019_team_season_logos.sql), so this is "their most current one on file," same reasoning DriverCareerStats uses the drivers table's own current name/photo for a driver spanning many seasons. */
  logoUrl: string | null;
  /** Count of seasons this team finished 1st in the Overall Team Standings. */
  championships: number;
  wins: number;
  podiums: number;
  poles: number;
  top5s: number;
  top10s: number;
  laps: number;
  lapsLed: number;
  starts: number;
  appearances: number;
  cornersPerIncident: number | null;
  /** Newest season first. */
  seasons: TeamCareerSeasonRow[];
}

export async function computeTeamCareerStats(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>,
  /** Skip this function's own computeDriverCareerStats call and pivot an already-fetched result instead — same sharing reasoning as this whole file's other `precomputed*` params. */
  precomputedDriverCareerStats?: DriverCareerStats[]
): Promise<TeamCareerStats[]> {
  const driverCareerStats = precomputedDriverCareerStats ?? (await computeDriverCareerStats(env, seasons, classes, exhibitionRoundIds));

  interface TeamSeasonAccum {
    season: Season;
    teamName: string;
    logoUrl: string | null;
    teamPosition: number | null;
    deltaTeamPosition: number | null;
    wins: number;
    podiums: number;
    top5s: number;
    top10s: number;
    poles: number;
    starts: number;
    appearances: number;
    laps: number;
    lapsLed: number;
    incidents: number;
    totalCorners: number;
    anyCornersResolved: boolean;
    drivers: TeamCareerSeasonDriver[];
  }
  // teamId -> seasonId -> that team's accumulated stats for that season
  const bySeasonByTeam = new Map<string, Map<string, TeamSeasonAccum>>();

  for (const driverStats of driverCareerStats) {
    for (const row of driverStats.seasons) {
      const primaryTeam = row.teams[0];
      if (!primaryTeam) continue; // no team that season — doesn't contribute to any team's stats

      if (!bySeasonByTeam.has(primaryTeam.teamId)) bySeasonByTeam.set(primaryTeam.teamId, new Map());
      const bySeasonId = bySeasonByTeam.get(primaryTeam.teamId)!;
      let accum = bySeasonId.get(row.season.id);
      if (!accum) {
        accum = {
          season: row.season,
          teamName: primaryTeam.teamName,
          logoUrl: primaryTeam.logoUrl,
          teamPosition: row.teamPosition,
          deltaTeamPosition: row.deltaTeamPosition,
          wins: 0,
          podiums: 0,
          top5s: 0,
          top10s: 0,
          poles: 0,
          starts: 0,
          appearances: 0,
          laps: 0,
          lapsLed: 0,
          incidents: 0,
          totalCorners: 0,
          anyCornersResolved: false,
          drivers: [],
        };
        bySeasonId.set(row.season.id, accum);
      }

      accum.wins += row.wins;
      accum.podiums += row.podiums;
      accum.top5s += row.top5s;
      accum.top10s += row.top10s;
      accum.poles += row.poles;
      accum.starts += row.starts;
      accum.appearances += row.appearances;
      accum.laps += row.laps;
      accum.lapsLed += row.lapsLed;
      accum.incidents += row.incidents;
      if (row.totalCorners !== null) {
        accum.totalCorners += row.totalCorners;
        accum.anyCornersResolved = true;
      }
      accum.drivers.push({
        driverId: driverStats.driver.id,
        name: driverStats.driver.name,
        carNumber: driverStats.driver.car_number,
        className: row.className,
        starts: row.starts,
        nationality1: driverStats.driver.nationality_1,
        nationality2: driverStats.driver.nationality_2,
      });
    }
  }

  const out: TeamCareerStats[] = [];
  for (const [teamId, bySeasonId] of bySeasonByTeam) {
    const accums = [...bySeasonId.values()].sort((a, b) => b.season.number - a.season.number);
    const seasonRows: TeamCareerSeasonRow[] = accums.map((a) => ({
      season: a.season,
      teamPosition: a.teamPosition,
      deltaTeamPosition: a.deltaTeamPosition,
      wins: a.wins,
      podiums: a.podiums,
      top5s: a.top5s,
      top10s: a.top10s,
      poles: a.poles,
      starts: a.starts,
      appearances: a.appearances,
      laps: a.laps,
      lapsLed: a.lapsLed,
      incidents: a.incidents,
      totalCorners: a.anyCornersResolved ? a.totalCorners : null,
      drivers: [...a.drivers].sort((x, y) => y.starts - x.starts),
    }));

    let championships = 0;
    let wins = 0;
    let podiums = 0;
    let poles = 0;
    let top5s = 0;
    let top10s = 0;
    let laps = 0;
    let lapsLed = 0;
    let starts = 0;
    let appearances = 0;
    let totalCorners = 0;
    let totalIncidents = 0;
    let anyCornersResolved = false;

    for (const r of seasonRows) {
      if (r.teamPosition === 1) championships++;
      wins += r.wins;
      podiums += r.podiums;
      poles += r.poles;
      top5s += r.top5s;
      top10s += r.top10s;
      laps += r.laps;
      lapsLed += r.lapsLed;
      starts += r.starts;
      appearances += r.appearances;
      totalIncidents += r.incidents;
      if (r.totalCorners !== null) {
        totalCorners += r.totalCorners;
        anyCornersResolved = true;
      }
    }

    // accums[0] is the most recent season (sorted above) — its name/logo
    // represent this team "as it is now" for the card header, same as a
    // driver's own current `drivers.name`/`photo_url` do for DriverCareerStats.
    out.push({
      teamId,
      teamName: accums[0].teamName,
      logoUrl: accums[0].logoUrl,
      championships,
      wins,
      podiums,
      poles,
      top5s,
      top10s,
      laps,
      lapsLed,
      starts,
      appearances,
      cornersPerIncident: anyCornersResolved && totalIncidents > 0 ? totalCorners / totalIncidents : null,
      seasons: seasonRows,
    });
  }

  out.sort((a, b) => a.teamName.localeCompare(b.teamName));
  return out;
}

// ---------------------------------------------------------------------------
// Race results — browsing rounds and their race-by-race results
// ---------------------------------------------------------------------------

const ROUND_SUMMARY_SELECT =
  'subsession_id,season_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers,status';

/** Every round for a season, most recent first. */
export function getRoundsForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&order=start_time.desc`
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

export async function getRoundBySubsessionId(env: SupabaseEnv, subsessionId: number) {
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${ROUND_SUMMARY_SELECT}&subsession_id=eq.${subsessionId}`
  );
  return rounds[0] ?? null;
}

/**
 * Recomputes each round's displayed "Round N" number, chronological within
 * the season, skipping any round that's an exhibition — either flagged
 * individually (`round_overrides`) or because the whole season isn't a
 * real championship (see `isChampionshipSeason`). Per Logan: flagging round
 * 1 as an exhibition should make round 2 become "Round 1", not leave a gap.
 * Returns null for an excluded round; the UI shows "Exhibition" instead of
 * "Round N" for those.
 */
export function computeDisplayRoundNumbers(
  rounds: RoundSummary[],
  exhibitionRoundIds: Set<number>
): Map<number, number | null> {
  const chronological = [...rounds].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );
  const out = new Map<number, number | null>();
  let counter = 0;
  for (const r of chronological) {
    const exhibition =
      exhibitionRoundIds.has(r.subsession_id) || (r.season_label ? !isChampionshipSeason(r.season_label) : false);
    out.set(r.subsession_id, exhibition ? null : ++counter);
  }
  return out;
}

export interface RaceResultRow {
  raceNumber: number;
  classId: number;
  /**
   * null for a disqualified driver — they're listed but don't occupy a
   * position. In the per-class view this is the class-relative position
   * (re-derived from curated_race_results, see the file header); in the
   * overall view it's `race_scores.scored_position` as-is, since that
   * column already is the overall field position — and the points system
   * is based on overall finishing position, not class-relative position.
   */
  position: number | null;
  dsq: boolean;
  driver: DriverBasic;
  finishPosition: number;
  startingPosition: number | null;
  wasAdjusted: boolean;
  totalPoints: number;
  /**
   * `total_points` is a generated column: finish_points + class_points +
   * finesse_bonus + pole_bonus + points_deduction. finish_points (the base
   * overall-position points) isn't broken out separately since it's most
   * of the total for every driver — everything else (class_points,
   * finesse_bonus, pole_bonus, points_deduction) is combined into one
   * "bonus points" figure shown under the Points total, and only when
   * nonzero.
   */
  bonusPoints: number;
  /**
   * `totalPoints` exactly as the pipeline/race_scores originally computed
   * it, before any penalty — this driver's own, or a cascade from someone
   * else's in the same race — was applied. `src/lib/penalties.ts`'s
   * `recomputeRow` only ever overwrites `totalPoints` (and its components)
   * on the returned row, never this field, so `totalPoints -
   * originalTotalPoints` is always a clean "how many points did this
   * round's penalties net this driver" figure — 0 for a row nothing ever
   * touched. Shown in the results table's expanded detail panel (see
   * ResultsTable.astro).
   */
  originalTotalPoints: number;
  /** The individual components `bonusPoints` above is the sum of — broken out (rather than only ever combined) so src/lib/penalties.ts can recompute just classPoints/pointsDeduction when a penalty changes this driver's position or applies a flat points penalty, while leaving finesseBonus/poleBonus (unaffected by either kind of penalty) alone. */
  classPoints: number;
  finesseBonus: number;
  poleBonus: number;
  pointsDeduction: number;
  polePosition: boolean;
  /** True when `finesse_bonus > 0` — the "3 incidents or less" bonus was actually awarded for this race (mirrors `polePosition`'s use of `pole_bonus > 0` rather than re-deriving the rule from a raw threshold). */
  incidentsBonus: boolean;
  incidents: number | null;
  laps: number | null;
  lapsLed: number | null;
  /**
   * General-purpose result tags, e.g. "Unclassified" (finished under 50% of
   * the leader's laps — driven by `race_scores.classified`, not re-derived
   * here). Deliberately a list rather than one string so a future tag (e.g.
   * a penalty) can sit alongside it — replaces the old single `reasonOut`
   * ("disconnected"-style) field, which added little value.
   */
  tags: string[];
  /**
   * Gap to the leader. Formatted "xx.xxx" (seconds) normally; "—" for the
   * leader themselves (a 0.000 gap) or when there's no interval on record;
   * "-xL" when the raw interval is negative, which iRacing uses to flag a
   * driver who finished one or more laps down (x = leader's laps_complete
   * minus this driver's) rather than a real time gap.
   */
  margin: string;
  /** The raw value `margin` above is formatted from (ten-thousandths of a second, negative = the "-xL" laps-down flag) — kept around unformatted so src/lib/penalties.ts can numerically re-sort the field around a time penalty. */
  intervalTenThousandths: number | null;
  /** Set by applyPenaltiesToRoundResults() (src/lib/penalties.ts) when a time penalty (this driver's own, or another driver's that cascaded past them) moved this driver from a different position — the position they'd have had before this round's penalties, so the UI can show it struck through next to the new one. Null when unaffected. */
  penaltyOldPosition: number | null;
  /** True once any penalty — time, points, or PP-only — has been logged against this driver for this specific race. Independent of penaltyOldPosition (a PP-only or points-only penalty doesn't necessarily move their position). */
  hasPenalty: boolean;
  /** The team this driver raced for in this specific race (from `race_scores.team_id`), or null if unassigned. `logoUrl` is that team's logo AS OF this round's season (0019_team_season_logos.sql) when a historical override exists, otherwise the team's current logo. */
  team: { name: string; logoUrl: string | null } | null;
  /** The car this driver used for this specific race (`curated_race_results.car_name`), or null if not recorded. */
  car: { name: string; logoUrl: string | null } | null;
  /** "1:42.512"-formatted average lap the race (see `formatLapTime` in src/lib/supabase.ts), from `curated_race_results.average_lap_ten_thousandths` (isolated fetch, see getLapStatsForSubsessions) — "—" when the pipeline hasn't got this for this driver/race. */
  averageLapFormatted: string;
  /** Raw ten-thousandths-of-a-second value averageLapFormatted is formatted from — kept unformatted, same reasoning as intervalTenThousandths, so src/lib/penalties.ts can do exact integer math with it (rule 18.3.2's "own laps × own average lap" — see reorderByTimePenalty) rather than round-tripping through the display string. Null when there's no data. */
  averageLapTenThousandths: number | null;
  /** This driver's single fastest lap the race, formatted the same way. Same source/isolation as averageLapFormatted. */
  bestLapFormatted: string;
  /**
   * "Overall race time" — own laps × own average lap (rule 18.3.2's method
   * for comparing drivers who aren't on the lead lap, where the normal
   * leader-relative `margin` above isn't a real time gap; see
   * reorderByTimePenalty in src/lib/penalties.ts) — "—" whenever
   * averageLapTenThousandths is null. Reflects any time penalty already
   * added in — this is the driver's FINAL effective total, not their raw
   * pre-penalty time — recomputed by applyPenaltiesToRoundResults()
   * whenever this driver (or one that cascaded past them) was penalized.
   */
  overallRaceTimeFormatted: string;
  /** Raw ten-thousandths-of-a-second value overallRaceTimeFormatted is formatted from — same reasoning as averageLapTenThousandths. Null when there's no data to compute it from. */
  overallRaceTimeTenThousandths: number | null;
}

export interface RoundResults {
  /** class_id -> race_number -> rows, ranked class-relative. */
  byClass: Map<number, Map<number, RaceResultRow[]>>;
  /** race_number -> rows (every class combined), ranked by overall field position. */
  overall: Map<number, RaceResultRow[]>;
}

type RaceScoreWithClass = RaceScoreRow & {
  class_id: number;
  team_id: string | null;
  scored_position: number | null;
  finish_points: number;
  class_points: number;
  finesse_bonus: number;
  points_deduction: number;
};

/**
 * Race-by-race results for one round, both grouped by class (ranked within
 * class, the same approach as `computeSeasonStandings`) and as a single
 * overall field per race (ranked by `race_scores.scored_position`, which the
 * points system itself is based on) — the results page lets visitors toggle
 * between the two.
 */
export async function getRoundResults(env: SupabaseEnv, subsessionId: number): Promise<RoundResults> {
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,finish_points,class_points,finesse_bonus,pole_bonus,points_deduction,total_points,classified,dsq,scored_position';
  const [scores, rawResults, drivers, teams, carLogos, round, seasonLogoRows, lapStats] = await Promise.all([
    restGet<RaceScoreWithClass[]>(env, `race_scores?select=${select}&subsession_id=eq.${subsessionId}`),
    getCuratedRaceResultsForSubsessions(env, [subsessionId]),
    driversSelect(env),
    getTeamsBasic(env),
    getCarLogos(env),
    getRoundBySubsessionId(env, subsessionId),
    getAllTeamSeasonLogosSafe(env),
    getLapStatsForSubsessions(env, [subsessionId]),
  ]);

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const lapStatsByKey = new Map(lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  // This round's season, for the historical-logo lookup below — team logos
  // shown on this round's results should reflect what the team looked like
  // THAT season (0019_team_season_logos.sql), not necessarily today.
  const seasonId = round?.season_id ?? null;
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  // Leader's laps_complete per race (finish_position === 1, i.e. the actual
  // on-track winner before any penalty adjustment) — needed to turn a
  // lapped driver's negative interval into a "-xL" margin. See
  // `formatMargin`. Also the leader's own average lap — src/lib/penalties.ts
  // uses it as the stand-in for "the leader's final lap pace" (rule 18.3.2
  // doesn't give us literal last-lap telemetry, only average-lap data) when
  // deciding whether a time penalty pushes someone an extra lap down.
  const leaderLapsByRace = new Map<number, number | null>();
  const leaderAverageLapByRace = new Map<number, number | null>();
  for (const r of rawResults) {
    if (r.finish_position === 1) {
      leaderLapsByRace.set(r.race_number, r.laps_complete);
      const custId = r.cust_id;
      leaderAverageLapByRace.set(
        r.race_number,
        lapStatsByKey.get(resultKey(r.subsession_id, r.race_number, custId))?.average_lap_ten_thousandths ?? null
      );
    }
  }

  function toRow(score: RaceScoreWithClass, driver: DriverBasic, raw: CuratedRaceResultRow, position: number | null): RaceResultRow {
    const team = score.team_id ? teamById.get(score.team_id) ?? null : null;
    const lapStatsRow = lapStatsByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id));
    const averageLapTenThousandths = lapStatsRow?.average_lap_ten_thousandths ?? null;
    const bestLapTenThousandths = lapStatsRow?.best_lap_ten_thousandths ?? null;
    const overallRaceTimeTenThousandths =
      averageLapTenThousandths !== null && raw.laps_complete !== null ? raw.laps_complete * averageLapTenThousandths : null;
    const tags: string[] = [];
    // `classified` is computed upstream by the results pipeline itself
    // (Logan: "anyone finishing less than 50% of the leader's laps do not
    // score any points and are unclassified") — trusting that field here
    // instead of re-deriving the 50% threshold in app code.
    if (!score.classified) tags.push('Unclassified');

    return {
      raceNumber: score.race_number,
      classId: score.class_id,
      position,
      dsq: score.dsq,
      driver,
      finishPosition: raw.finish_position,
      startingPosition: raw.starting_position,
      wasAdjusted: raw.adjusted_position !== null && raw.adjusted_position !== raw.finish_position,
      totalPoints: score.total_points,
      originalTotalPoints: score.total_points,
      bonusPoints: score.class_points + score.finesse_bonus + score.pole_bonus + score.points_deduction,
      classPoints: score.class_points,
      finesseBonus: score.finesse_bonus,
      poleBonus: score.pole_bonus,
      pointsDeduction: score.points_deduction,
      polePosition: score.pole_bonus > 0,
      incidentsBonus: score.finesse_bonus > 0,
      incidents: raw.incidents,
      laps: raw.laps_complete,
      lapsLed: raw.laps_led,
      tags,
      margin: formatMargin(raw.interval_ten_thousandths, raw.laps_complete, leaderLapsByRace.get(score.race_number) ?? null),
      intervalTenThousandths: raw.interval_ten_thousandths,
      penaltyOldPosition: null,
      hasPenalty: false,
      team: team ? { name: team.name, logoUrl: resolveTeamLogo(team, seasonId, seasonLogoMap) } : null,
      car: raw.car_name ? { name: raw.car_name, logoUrl: carLogoByName.get(raw.car_name) ?? null } : null,
      averageLapFormatted: formatLapTime(averageLapTenThousandths !== null ? averageLapTenThousandths / 10000 : null),
      averageLapTenThousandths,
      bestLapFormatted: formatLapTime(bestLapTenThousandths !== null ? bestLapTenThousandths / 10000 : null),
      overallRaceTimeFormatted: formatLapTime(overallRaceTimeTenThousandths !== null ? overallRaceTimeTenThousandths / 10000 : null),
      overallRaceTimeTenThousandths,
    };
  }

  interface Matched {
    score: RaceScoreWithClass;
    driver: DriverBasic;
    raw: CuratedRaceResultRow;
  }
  const matched: Matched[] = [];
  for (const s of scores) {
    const driver = driverById.get(s.driver_id);
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    if (driver && raw) matched.push({ score: s, driver, raw });
  }

  // --- Per class: class-relative position, re-derived from curated_race_results ---
  const byClassThenRace = new Map<number, Map<number, Matched[]>>();
  for (const m of matched) {
    if (!byClassThenRace.has(m.score.class_id)) byClassThenRace.set(m.score.class_id, new Map());
    const byRace = byClassThenRace.get(m.score.class_id)!;
    if (!byRace.has(m.score.race_number)) byRace.set(m.score.race_number, []);
    byRace.get(m.score.race_number)!.push(m);
  }

  const byClass = new Map<number, Map<number, RaceResultRow[]>>();
  for (const [classId, byRace] of byClassThenRace) {
    const classOut = new Map<number, RaceResultRow[]>();
    for (const [raceNumber, group] of byRace) {
      const rawPos = (m: Matched) => m.raw.adjusted_position ?? m.raw.finish_position;
      // Disqualified drivers don't occupy a class position — everyone else
      // ranks as if they weren't there — but they're still listed, at the
      // bottom, so the results page shows the complete field.
      const ranked = group.filter((m) => !m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      const dsqd = group.filter((m) => m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      classOut.set(raceNumber, [
        ...ranked.map((m, i) => toRow(m.score, m.driver, m.raw, i + 1)),
        ...dsqd.map((m) => toRow(m.score, m.driver, m.raw, null)),
      ]);
    }
    byClass.set(classId, classOut);
  }

  // --- Overall: every class combined, ranked by race_scores.scored_position ---
  const byRaceAll = new Map<number, Matched[]>();
  for (const m of matched) {
    if (!byRaceAll.has(m.score.race_number)) byRaceAll.set(m.score.race_number, []);
    byRaceAll.get(m.score.race_number)!.push(m);
  }

  const overallRawPos = (m: Matched) => m.raw.adjusted_position ?? m.raw.finish_position;
  const overall = new Map<number, RaceResultRow[]>();
  for (const [raceNumber, group] of byRaceAll) {
    const ranked = group
      .filter((m) => !m.score.dsq && m.score.scored_position !== null)
      .sort((a, b) => (a.score.scored_position as number) - (b.score.scored_position as number));
    // Anything without a usable scored_position (unexpected, but the field
    // is nullable) falls back to the same raw-position sort used for DSQs,
    // and is shown without a position — consistent with the per-class view.
    const unranked = group
      .filter((m) => m.score.dsq || m.score.scored_position === null)
      .sort((a, b) => overallRawPos(a) - overallRawPos(b));
    overall.set(raceNumber, [
      ...ranked.map((m) => toRow(m.score, m.driver, m.raw, m.score.scored_position)),
      ...unranked.map((m) => toRow(m.score, m.driver, m.raw, null)),
    ]);
  }

  return { byClass, overall };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11/12/13 -> "11th"/"12th"/"13th", etc. */
export function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const rem100 = n % 100;
  const suffix = suffixes[(rem100 - 20) % 10] ?? suffixes[rem100] ?? suffixes[0];
  return `${n}${suffix}`;
}

/** e.g. pctOf(4, 12) -> "33% of starts". Returns an em dash when the denominator is 0. */
export function pctOf(count: number, denominator: number, ofWhat: string): string {
  if (denominator <= 0) return '—';
  return `${Math.round((count / denominator) * 100)}% of ${ofWhat}`;
}

/**
 * Converts iRacing's `interval_ten_thousandths` gap-to-leader into "xx.xxx"
 * seconds. The leader's own gap is 0 by definition, which isn't a
 * meaningful "margin" to show next to their name — that (and a missing
 * interval) both display as "—" instead of "0.000".
 *
 * A negative interval (iRacing typically reports this as displaying like
 * "-0.000") isn't a real time gap — it's iRacing's way of flagging that this
 * driver finished one or more laps down rather than close behind on the
 * same lap (Logan: "most likely a lap down or more"). When that happens,
 * `ownLaps`/`leaderLaps` (both from `curated_race_results.laps_complete`)
 * are used to show "-xL" (x laps down) instead of a bogus time gap.
 */
export function formatMargin(
  intervalTenThousandths: number | null,
  ownLaps: number | null,
  leaderLaps: number | null
): string {
  if (intervalTenThousandths === null) return '—';
  if (intervalTenThousandths < 0) {
    if (ownLaps !== null && leaderLaps !== null && leaderLaps > ownLaps) {
      return `-${leaderLaps - ownLaps}L`;
    }
    return '—';
  }
  if (intervalTenThousandths === 0) return '—';
  return (intervalTenThousandths / 10000).toFixed(3);
}

/** Builds the URL for a race's results on iRacing's own site from its real iRacing subsession id (see `race_links` / 0007_race_links.sql — NOT the same as this app's own `subsession_id` grouping key). */
export function iracingResultsUrl(iracingSubsessionId: number): string {
  return `https://members-ng.iracing.com/web/racing/results-stats/results?subsessionid=${iracingSubsessionId}`;
}
