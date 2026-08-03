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
 *    `getRoundResultsByClass` below do this same re-ranking). Per race,
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

import { restGet, type SupabaseEnv } from './supabase';
import type { Season } from './supabase';

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

interface RaceScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  total_points: number;
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
  reason_out: string | null;
}

export interface RoundSummary {
  subsession_id: number;
  start_time: string;
  track_name: string;
  season_label: string | null;
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
}

function driversSelect(env: SupabaseEnv) {
  return restGet<DriverBasic[]>(env, 'drivers?select=id,name,car_number,photo_url,iracing_cust_id');
}

function getRaceScoresForSeasonClass(env: SupabaseEnv, seasonId: string, classId: number) {
  const select = 'subsession_id,race_number,driver_id,total_points,pole_bonus,classified,dsq';
  return restGet<RaceScoreRow[]>(
    env,
    `race_scores?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}`
  );
}

function getCuratedRaceResultsForSubsessions(env: SupabaseEnv, subsessionIds: number[]) {
  if (subsessionIds.length === 0) return Promise.resolve([] as CuratedRaceResultRow[]);
  const select =
    'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,reason_out';
  return restGet<CuratedRaceResultRow[]>(
    env,
    `curated_race_results?select=${select}&subsession_id=in.(${subsessionIds.join(',')})`
  );
}

function resultKey(subsessionId: number, raceNumber: number, custId: number) {
  return `${subsessionId}:${raceNumber}:${custId}`;
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
}

const BASELINE_DROP_WEEKS = 2;

/**
 * Computes the full standings for one season+class, sorted by points
 * (ties broken by wins, then podiums). Pass a pre-fetched `driversBasic`
 * list when computing many seasons back to back (see `getChampions`) to
 * avoid re-fetching the whole roster every time.
 */
export async function computeSeasonStandings(
  env: SupabaseEnv,
  season: Season,
  classId: number,
  driversBasic?: DriverBasic[]
): Promise<DriverSeasonStanding[]> {
  const [scores, drivers] = await Promise.all([
    getRaceScoresForSeasonClass(env, season.id, classId),
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
  ]);
  if (scores.length === 0) return [];

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
  const rawResults = await getCuratedRaceResultsForSubsessions(env, subsessionIds);
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));

  // Group this class's race_scores rows by (subsession_id, race_number) so
  // each individual race can be ranked within the class.
  const raceGroups = new Map<string, RaceScoreRow[]>();
  for (const s of scores) {
    const key = `${s.subsession_id}:${s.race_number}`;
    if (!raceGroups.has(key)) raceGroups.set(key, []);
    raceGroups.get(key)!.push(s);
  }

  interface Accum {
    starts: number;
    subsessionIds: Set<number>;
    poleSubsessionIds: Set<number>;
    wins: number;
    podiums: number;
    top5s: number;
    top10s: number;
    roundPoints: Map<number, number>;
  }
  const accum = new Map<string, Accum>();
  function getAccum(driverId: string): Accum {
    let a = accum.get(driverId);
    if (!a) {
      a = {
        starts: 0,
        subsessionIds: new Set(),
        poleSubsessionIds: new Set(),
        wins: 0,
        podiums: 0,
        top5s: 0,
        top10s: 0,
        roundPoints: new Map(),
      };
      accum.set(driverId, a);
    }
    return a;
  }

  // Rank every race, class-relative, using the raw imported position.
  // Disqualified results are excluded from the ranking entirely (not just
  // demoted to last) so a DSQ'd driver can never be credited with a
  // win/podium/top 5/top 10, and everyone behind them ranks up normally —
  // they still count toward that driver's own starts/appearances/points
  // below, just not toward anyone's class position.
  for (const group of raceGroups.values()) {
    const ranked = group
      .filter((s) => !s.dsq)
      .map((s) => {
        const custId = custIdByDriverId.get(s.driver_id);
        const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
        const position = raw?.adjusted_position ?? raw?.finish_position ?? null;
        return { score: s, position };
      })
      .filter((r) => r.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number));

    ranked.forEach((r, i) => {
      const classRank = i + 1;
      const a = getAccum(r.score.driver_id);
      if (classRank === 1) a.wins++;
      if (classRank <= 3) a.podiums++;
      if (classRank <= 5) a.top5s++;
      if (classRank <= 10) a.top10s++;
    });
  }

  // Starts, appearances, poles, and points come straight from race_scores
  // regardless of whether a matching curated_race_results row was found.
  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.starts += 1;
    a.subsessionIds.add(s.subsession_id);
    if (s.pole_bonus > 0) a.poleSubsessionIds.add(s.subsession_id);
    a.roundPoints.set(s.subsession_id, (a.roundPoints.get(s.subsession_id) ?? 0) + s.total_points);
  }

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
    });
  }

  standings.sort((x, y) => y.totalPoints - x.totalPoints || y.wins - x.wins || y.podiums - x.podiums);

  return standings.map((s, i) => ({ ...s, position: i + 1 }));
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
  const drivers = await driversSelect(env);
  const perSeason = await Promise.all(
    seasons.map(async (season) => {
      const standings = await computeSeasonStandings(env, season, classId, drivers);
      return standings.length > 0 ? { season, standing: standings[0] } : null;
    })
  );
  return perSeason.filter((r): r is ChampionEntry => r !== null);
}

// ---------------------------------------------------------------------------
// Race results — browsing rounds and their race-by-race results
// ---------------------------------------------------------------------------

/** Every round for a season, most recent first. */
export function getRoundsForSeason(env: SupabaseEnv, seasonId: string) {
  const select =
    'subsession_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers,status';
  return restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${select}&season_id=eq.${encodeURIComponent(seasonId)}&order=start_time.desc`
  );
}

export async function getRoundBySubsessionId(env: SupabaseEnv, subsessionId: number) {
  const select =
    'subsession_id,start_time,track_name,season_label,round_number,format,strength_of_field,num_drivers,status';
  const rounds = await restGet<RoundSummary[]>(
    env,
    `curated_rounds?select=${select}&subsession_id=eq.${subsessionId}`
  );
  return rounds[0] ?? null;
}

export interface RaceResultRow {
  raceNumber: number;
  /** null for a disqualified driver — they're listed but don't occupy a class position. */
  classRank: number | null;
  dsq: boolean;
  driver: DriverBasic;
  finishPosition: number;
  startingPosition: number | null;
  wasAdjusted: boolean;
  totalPoints: number;
  polePosition: boolean;
  incidents: number | null;
  reasonOut: string | null;
}

/**
 * Race-by-race results for one round, grouped by class then ranked within
 * class — the same ranking approach as `computeSeasonStandings`, just for a
 * single round instead of a whole season.
 */
export async function getRoundResultsByClass(
  env: SupabaseEnv,
  subsessionId: number
): Promise<Map<number, Map<number, RaceResultRow[]>>> {
  const select = 'subsession_id,race_number,driver_id,class_id,total_points,pole_bonus,classified,dsq';
  const [scores, rawResults, drivers] = await Promise.all([
    restGet<(RaceScoreRow & { class_id: number })[]>(
      env,
      `race_scores?select=${select}&subsession_id=eq.${subsessionId}`
    ),
    getCuratedRaceResultsForSubsessions(env, [subsessionId]),
    driversSelect(env),
  ]);

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number])
  );
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));

  // class_id -> race_number -> rows
  const byClassThenRace = new Map<number, Map<number, RaceScoreRow[]>>();
  for (const s of scores) {
    if (!byClassThenRace.has(s.class_id)) byClassThenRace.set(s.class_id, new Map());
    const byRace = byClassThenRace.get(s.class_id)!;
    if (!byRace.has(s.race_number)) byRace.set(s.race_number, []);
    byRace.get(s.race_number)!.push(s);
  }

  interface RankedRow {
    score: RaceScoreRow;
    driver: DriverBasic;
    raw: CuratedRaceResultRow;
    position: number;
  }

  const out = new Map<number, Map<number, RaceResultRow[]>>();
  for (const [classId, byRace] of byClassThenRace) {
    const classOut = new Map<number, RaceResultRow[]>();
    for (const [raceNumber, group] of byRace) {
      const ranked: RankedRow[] = [];
      const dsqd: RankedRow[] = [];
      for (const s of group) {
        const driver = driverById.get(s.driver_id);
        const custId = custIdByDriverId.get(s.driver_id);
        const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
        const position = raw?.adjusted_position ?? raw?.finish_position ?? null;
        if (driver && raw && position !== null) {
          (s.dsq ? dsqd : ranked).push({ score: s, driver, raw, position });
        }
      }
      // Disqualified drivers don't occupy a class position — everyone else
      // ranks as if they weren't there — but they're still listed, at the
      // bottom, so the results page shows the complete field.
      ranked.sort((a, b) => a.position - b.position);
      dsqd.sort((a, b) => a.position - b.position);

      const toRow = (r: RankedRow, classRank: number | null): RaceResultRow => ({
        raceNumber,
        classRank,
        dsq: r.score.dsq,
        driver: r.driver,
        finishPosition: r.raw.finish_position,
        startingPosition: r.raw.starting_position,
        wasAdjusted: r.raw.adjusted_position !== null && r.raw.adjusted_position !== r.raw.finish_position,
        totalPoints: r.score.total_points,
        polePosition: r.score.pole_bonus > 0,
        incidents: r.raw.incidents,
        reasonOut: r.raw.reason_out,
      });

      classOut.set(raceNumber, [
        ...ranked.map((r, i) => toRow(r, i + 1)),
        ...dsqd.map((r) => toRow(r, null)),
      ]);
    }
    out.set(classId, classOut);
  }

  return out;
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
