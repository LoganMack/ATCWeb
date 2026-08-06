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

import { restGet, getExhibitionRoundIds, getCarLogos, getSeasons, getPenaltiesForSubsessions, type SupabaseEnv } from './supabase';
import type { Season, CarLogo, Penalty } from './supabase';
import {
  computeSeasonOverallAdjustments,
  computeSeasonClassAdjustments,
  type SeasonScoreRow,
  type SeasonClassScoreRow,
  type SeasonOverallAdjustment,
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
}

function driversSelect(env: SupabaseEnv) {
  return restGet<DriverBasic[]>(env, 'drivers?select=id,name,car_number,photo_url,iracing_cust_id,is_rookie');
}

function getRaceScoresForSeasonClass(env: SupabaseEnv, seasonId: string, classId: number) {
  const select =
    'subsession_id,race_number,driver_id,total_points,class_points,finesse_bonus,points_deduction,pole_bonus,classified,dsq';
  return restGet<RaceScoreRow[]>(
    env,
    `race_scores?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}`
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
  return restGet<CuratedRaceResultRow[]>(
    env,
    `curated_race_results?select=${select}&subsession_id=in.(${subsessionIds.join(',')})`
  );
}

interface TeamBasic {
  id: string;
  name: string;
  logo_url: string | null;
}

/** Lean team lookup (id/name/logo only) for showing the team a driver raced for on a given race_scores row — see `RaceResultRow.team`. */
function getTeamsBasic(env: SupabaseEnv) {
  return restGet<TeamBasic[]>(env, 'teams?select=id,name,logo_url');
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
 */
async function getSeasonOverallContext(
  env: SupabaseEnv,
  season: Season,
  exhibitionIds: Set<number>,
  drivers: DriverBasic[]
): Promise<SeasonOverallContext> {
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );

  const overallScoresRaw = await getRaceScoresForSeasonOverall(env, season.id);
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
    };
  }

  const subsessionIds = [...new Set(overallScores.map((s) => s.subsession_id))];
  const [rawResults, penalties, seasonRounds] = await Promise.all([
    getCuratedRaceResultsForSubsessions(env, subsessionIds),
    getPenaltiesForSubsessions(env, subsessionIds),
    getRoundsForSeason(env, season.id),
  ]);
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const formatBySubsession = new Map(seasonRounds.map((r) => [r.subsession_id, r.format]));

  if (penalties.length === 0) {
    return { adjustments: new Map(), penalties, formatBySubsession, rawByKey, overallScores, custIdByDriverId };
  }

  const seasonScoreRows: SeasonScoreRow[] = overallScores.map((s) => {
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
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
    };
  });

  const adjustments = computeSeasonOverallAdjustments(seasonScoreRows, penalties, formatBySubsession);
  return { adjustments, penalties, formatBySubsession, rawByKey, overallScores, custIdByDriverId };
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
    roundPoints: new Map(),
  };
}

/** Shared by both `computeSeasonStandings` and `computeOverallSeasonStandings` — turns the per-driver accumulators built by each into sorted, positioned standings (worst-rounds-dropped point totals, then wins/podiums as tiebreakers). */
function finalizeStandings(
  accum: Map<string, StandingsAccum>,
  driverById: Map<string, DriverBasic>,
  season: Season
): DriverSeasonStanding[] {
  const totalDrops = BASELINE_DROP_WEEKS + (season.extra_drop_weeks ?? 0);

  const standings: Omit<DriverSeasonStanding, 'position'>[] = [];
  for (const [driverId, a] of accum) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    const roundTotals = [...a.roundPoints.values()].sort((x, y) => y - x);
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
      classId: a.classId,
    });
  }

  standings.sort((x, y) => y.totalPoints - x.totalPoints || y.wins - x.wins || y.podiums - x.podiums);

  return standings.map((s, i) => ({ ...s, position: i + 1 }));
}

/**
 * Computes the full standings for one season+class, sorted by points
 * (ties broken by wins, then podiums). Pass a pre-fetched `driversBasic`
 * list (and `exhibitionRoundIds`) when computing many seasons back to back
 * (see `getChampions`) to avoid re-fetching the same data every time.
 *
 * Returns an empty list for a non-championship (exhibition) season without
 * querying anything else — see `isChampionshipSeason`.
 */
export async function computeSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  classId: number,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [scoresRaw, drivers, exhibitionIds] = await Promise.all([
    getRaceScoresForSeasonClass(env, season.id, classId),
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
  ]);
  // Individual rounds can be flagged exhibition even inside a real
  // championship season (e.g. a pre-season race) — those never count
  // toward standings, same as a whole exhibition season.
  const scores = exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
  const rawResults = await getCuratedRaceResultsForSubsessions(env, subsessionIds);
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));

  // Cross-class penalty context — this class's finish points are based on
  // OVERALL field position, which a penalty against a driver in a DIFFERENT
  // class in the same race can also shift, so this class's own (filtered)
  // `scores` alone isn't enough to know that. See getSeasonOverallContext.
  const overallContext = await getSeasonOverallContext(env, season, exhibitionIds, drivers);

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
        return { score: s, position: raw?.adjusted_position ?? raw?.finish_position ?? null, interval: raw?.interval_ten_thousandths ?? null };
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
      });
    });
  }

  const classAdjustments = computeSeasonClassAdjustments(
    classScoreRows,
    overallContext.penalties,
    overallContext.formatBySubsession,
    overallContext.adjustments
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

  // Starts, appearances, poles, and points come straight from race_scores
  // regardless of whether a matching curated_race_results row was found —
  // except total_points, which uses the penalty-adjusted figure whenever
  // this race actually has one logged.
  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    if (s.pole_bonus > 0) a.poleSubsessionIds.add(s.subsession_id);
    const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
    const adjustment = classAdjustments.get(key);
    const totalPoints = adjustment ? adjustment.totalPoints : s.total_points;
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + totalPoints);
  }

  return finalizeStandings(accum, driverById, season);
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
 * results page's "Overall" view uses, and simpler/no `curated_race_results`
 * lookup needed since `scored_position` doesn't need re-deriving.
 */
export async function computeOverallSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  driversBasic?: DriverBasic[],
  exhibitionRoundIds?: Set<number>
): Promise<DriverSeasonStanding[]> {
  if (!isChampionshipSeason(season.name)) return [];

  const [drivers, exhibitionIds] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
  ]);

  const overallContext = await getSeasonOverallContext(env, season, exhibitionIds, drivers);
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

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.classId = s.class_id;
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    if (s.pole_bonus > 0) a.poleSubsessionIds.add(s.subsession_id);

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

  return finalizeStandings(accum, driverById, season);
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
 * Per-driver "which cars/teams did they use this season, how often" —
 * computed once for the whole season (every class, regardless of which
 * standings view — overall or per-class — is actually being shown), since
 * a driver's car/team usage isn't itself a per-class-view concern.
 *
 * Team `racesScoredForTeam` implements Logan's rule: "only the top 2
 * scoring drivers for each team add their points to the team championship
 * per race" — for every (race, team) group, this ranks that team's drivers
 * who raced that specific race by their points that race (finish + finesse
 * + pole + deduction, same formula `computeOverallSeasonStandings` uses)
 * and credits the top 2.
 */
export async function getSeasonCarTeamStats(
  env: SupabaseEnv,
  season: Season,
  exhibitionRoundIds?: Set<number>
): Promise<Map<string, DriverSeasonExtras>> {
  const [scoresRaw, drivers, teams, carLogos, exhibitionIds] = await Promise.all([
    getRaceScoresForSeasonOverall(env, season.id),
    driversSelect(env),
    getTeamsBasic(env),
    getCarLogos(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getExhibitionRoundIds(env),
  ]);
  const scores = exhibitionIds.size > 0 ? scoresRaw.filter((s) => !exhibitionIds.has(s.subsession_id)) : scoresRaw;
  if (scores.length === 0) return new Map();

  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
  const rawResults = await getCuratedRaceResultsForSubsessions(env, subsessionIds);
  const carNameByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r.car_name]));

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
  for (const group of teamRaceGroups.values()) {
    const pointsOf = (s: RaceScoreOverallRow) => s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
    const ranked = [...group].sort((a, b) => pointsOf(b) - pointsOf(a));
    for (const s of ranked.slice(0, 2)) {
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
              logoUrl: team?.logo_url ?? null,
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
  const [drivers, exhibitionRoundIds] = await Promise.all([driversSelect(env), getExhibitionRoundIds(env)]);
  const perSeason = await Promise.all(
    seasons.map(async (season) => {
      const standings = await computeSeasonStandings(env, season, classId, drivers, exhibitionRoundIds);
      return standings.length > 0 ? { season, standing: standings[0] } : null;
    })
  );
  return perSeason.filter((r): r is ChampionEntry => r !== null);
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
  return restGet<RoundSummary[]>(env, `curated_rounds?select=${ROUND_SUMMARY_SELECT}&order=start_time.desc`);
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
  /** The team this driver raced for in this specific race (from `race_scores.team_id`), or null if unassigned. */
  team: { name: string; logoUrl: string | null } | null;
  /** The car this driver used for this specific race (`curated_race_results.car_name`), or null if not recorded. */
  car: { name: string; logoUrl: string | null } | null;
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
  const [scores, rawResults, drivers, teams, carLogos] = await Promise.all([
    restGet<RaceScoreWithClass[]>(env, `race_scores?select=${select}&subsession_id=eq.${subsessionId}`),
    getCuratedRaceResultsForSubsessions(env, [subsessionId]),
    driversSelect(env),
    getTeamsBasic(env),
    getCarLogos(env),
  ]);

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));

  // Leader's laps_complete per race (finish_position === 1, i.e. the actual
  // on-track winner before any penalty adjustment) — needed to turn a
  // lapped driver's negative interval into a "-xL" margin. See
  // `formatMargin`.
  const leaderLapsByRace = new Map<number, number | null>();
  for (const r of rawResults) {
    if (r.finish_position === 1) leaderLapsByRace.set(r.race_number, r.laps_complete);
  }

  function toRow(score: RaceScoreWithClass, driver: DriverBasic, raw: CuratedRaceResultRow, position: number | null): RaceResultRow {
    const team = score.team_id ? teamById.get(score.team_id) ?? null : null;
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
      team: team ? { name: team.name, logoUrl: team.logo_url } : null,
      car: raw.car_name ? { name: raw.car_name, logoUrl: carLogoByName.get(raw.car_name) ?? null } : null,
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
