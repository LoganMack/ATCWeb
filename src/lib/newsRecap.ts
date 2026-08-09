/**
 * Computes a round's race recap for a news post linked to it
 * (`news_posts.round_subsession_id`, see 0017_news_round_season.sql) — top
 * 3 per class, top 3 rookies, fastest lap (+ track record check), and team
 * points, all per race.
 *
 * Deliberately NOT stored text: every value here is recomputed fresh from
 * the same live, penalty-adjusted data the results pages themselves show
 * (getRoundResults() + applyPenaltiesToRoundResults(), exactly like
 * src/pages/results/[subsessionId].astro), so if a penalty gets logged
 * against this round after the post is published, the recap on the article
 * updates the next time it's viewed — no "regenerate" step, nothing to go
 * stale. src/pages/news/[slug].astro calls computeRoundRecap() at render
 * time and renders the result; nothing about it is persisted.
 *
 * Track-record matching (matchCircuitLayout() below) is a direct, exact
 * (normalized) match on track/layout name per Logan — not a fuzzy guess —
 * using a `layout` column this repo added to `curated_rounds` specifically
 * for this (see 0018_curated_rounds_layout.sql for why that's a deliberate,
 * one-off exception to this repo never altering the pipeline's own
 * tables). When it can't resolve to exactly one circuit_layouts row, the
 * recap just omits the track-record comparison and computeRoundRecap()
 * returns a `trackRecordMatchIssue` explaining why, for an admin-only
 * notice on the article (see news/[slug].astro) — never shown to visitors.
 */

import {
  restGet,
  getPenaltiesForSubsession,
  getDriverClasses,
  getCircuits,
  getAllCircuitLayouts,
  formatLapTime,
  type Circuit,
  type CircuitLayout,
  type SupabaseEnv,
} from './supabase';
import { getRoundBySubsessionId, getRoundResults, topTeamScorers, type DriverBasic, type RoundResults, type RaceResultRow } from './results';
import { applyPenaltiesToRoundResults } from './penalties';

interface RawBestLapRow {
  race_number: number;
  cust_id: number;
  best_lap_ten_thousandths: number | null;
}

/**
 * Fetches just this round's fastest-lap data, deliberately kept OUT of
 * results.ts's shared getCuratedRaceResultsForSubsessions() (used by every
 * results/standings/champions page) even though it's the same
 * `curated_race_results` table. PostgREST fails the ENTIRE query if any
 * selected column doesn't exist (see results.ts's header) — isolating this
 * one column's fetch to its own small query, in its own try/catch, means a
 * wrong/renamed column can only ever make the recap quietly drop its
 * "fastest lap" stat, never take down the rest of the site.
 */
async function fetchBestLaps(env: SupabaseEnv, subsessionId: number): Promise<RawBestLapRow[]> {
  try {
    return await restGet<RawBestLapRow[]>(
      env,
      `curated_race_results?select=race_number,cust_id,best_lap_ten_thousandths&subsession_id=eq.${subsessionId}`
    );
  } catch (err) {
    console.error('News recap: failed to fetch fastest-lap data, omitting that stat:', err);
    return [];
  }
}

/**
 * Fetches just this round's `layout` column (see
 * 0018_curated_rounds_layout.sql — a column this repo added to the
 * otherwise pipeline-owned `curated_rounds` table, purely for this
 * track-record match), isolated in its own try/catch for the same reason as
 * fetchBestLaps() above: results.ts's shared round queries (used by every
 * results/schedule/standings page) must never risk failing over one column
 * that only this one feature needs. Rounds imported before this column
 * existed, or before Logan has filled it in for a given round, just come
 * back null — matchCircuitLayout() degrades gracefully in that case.
 */
async function fetchRoundLayout(env: SupabaseEnv, subsessionId: number): Promise<string | null> {
  try {
    const rows = await restGet<{ layout: string | null }[]>(
      env,
      `curated_rounds?select=layout&subsession_id=eq.${subsessionId}`
    );
    return rows[0]?.layout ?? null;
  } catch (err) {
    console.error('News recap: failed to fetch round layout, skipping track-record match:', err);
    return null;
  }
}

export interface RecapClassTop3 {
  classId: number;
  className: string;
  top3: { position: number; driver: DriverBasic; teamName: string | null; teamLogoUrl: string | null }[];
}

export interface RecapRookieEntry {
  position: number | null;
  driver: DriverBasic;
}

export interface RecapFastestLap {
  driver: DriverBasic;
  formatted: string;
  isTrackRecord: boolean;
  previousRecordFormatted: string | null;
}

/** One driver who was awarded the "Sublime Finesse" bonus (finesse_bonus > 0 — "3 incidents or less" that race) — see README's Points System note. */
export interface RecapFinesseEntry {
  driver: DriverBasic;
  carNumber: number | null;
  incidents: number | null;
}

/** One driver among a race's top 5 position gainers ("Naked Aggression") — positionsGained is startingPosition - finishPosition, so a bigger number means a bigger charge through the field. */
export interface RecapOvertakeEntry {
  driver: DriverBasic;
  carNumber: number | null;
  startingPosition: number;
  finishPosition: number;
  positionsGained: number;
}

export interface RecapRace {
  raceNumber: number;
  topByClass: RecapClassTop3[];
  topRookies: RecapRookieEntry[];
  fastestLap: RecapFastestLap | null;
  /** Every driver awarded the Sublime Finesse bonus this race — not just a top-N, since it's an all-or-nothing per-driver bonus, not a ranking. */
  sublimeFinesse: RecapFinesseEntry[];
  /** Top 5 position gainers this race (whole field, every class combined) — "Naked Aggression." */
  nakedAggression: RecapOvertakeEntry[];
}

export interface RecapTeamPoints {
  teamName: string;
  logoUrl: string | null;
  points: number;
}

export interface RecapTeamDriverEntry {
  raceNumber: number;
  driverName: string;
  carNumber: number | null;
  points: number;
  nationality1: string | null;
  nationality2: string | null;
}

export interface RecapTeamBreakdown {
  teamName: string;
  logoUrl: string | null;
  entries: RecapTeamDriverEntry[];
}

export interface RoundRecap {
  subsessionId: number;
  trackName: string;
  races: RecapRace[];
  /** Highest combined points across every class this round — the main team battle. Null only if nobody in the round had a team assigned. */
  topTeamOverall: RecapTeamPoints | null;
  /** Highest points among just the Delta class this round (Delta has its own class_points bonus separate from the overall total — see results.ts's header) — null if this round had no Delta class field, or nobody in it had a team assigned. */
  topTeamDelta: RecapTeamPoints | null;
  /** Every team's top-2-per-race scorers (see topTeamScorers()), with which driver scored what in which race — sorted by team name. */
  teamBreakdown: RecapTeamBreakdown[];
  /** Same idea as `teamBreakdown`, but scoped to just Delta-class rows and ranked/summed by each row's full totalPoints (Delta's own class_points bonus included) — mirrors topTeamDelta. Empty when this round had no Delta class field. */
  deltaTeamBreakdown: RecapTeamBreakdown[];
  /**
   * Set only when the round's track/layout couldn't be matched to a
   * circuit_layouts row, so no fastest lap in `races` can be checked
   * against a lap record. A human-readable reason, meant for an
   * admin-only on-page notice (see news/[slug].astro's use of
   * isAdminView()) so Logan knows what to go add/fix in Admin → Circuits —
   * never shown to regular visitors.
   */
  trackRecordMatchIssue: string | null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface LayoutMatchResult {
  layout: CircuitLayout | null;
  /** Non-null exactly when layout is null — see RoundRecap.trackRecordMatchIssue. */
  issue: string | null;
}

/**
 * Matches a round's `track_name` (and, when needed, its `layout` column —
 * see 0018_curated_rounds_layout.sql) to one of this repo's own
 * `circuit_layouts` rows (admin-managed at /admin/circuits), per Logan:
 * track names are consistent everywhere, so this is a direct (normalized —
 * case/punctuation/whitespace-insensitive, not fuzzy) match on
 * circuits.name, not a best-effort guess. A circuit with only one layout on
 * file resolves from the track name alone; one with more than one layout
 * needs the round's `layout` to also match one of circuit_layouts.name to
 * disambiguate which config was actually run. Returns a human-readable
 * `issue` whenever it can't resolve to exactly one layout, rather than
 * guessing — surfaced as an admin-only notice on the article (never shown
 * to visitors) so Logan knows what's missing in Admin → Circuits.
 */
function matchCircuitLayout(
  trackName: string,
  roundLayout: string | null,
  circuits: Circuit[],
  layouts: CircuitLayout[]
): LayoutMatchResult {
  const targetTrack = normalize(trackName);
  const circuit = circuits.find((c) => normalize(c.name) === targetTrack) ?? null;
  if (!circuit) {
    return {
      layout: null,
      issue: `No circuit in Admin → Circuits is named "${trackName}" (this round's track) — add it there to enable track-record checking.`,
    };
  }

  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuit.id);
  if (circuitLayouts.length === 0) {
    return { layout: null, issue: `"${circuit.name}" has no layouts configured in Admin → Circuits yet.` };
  }
  if (circuitLayouts.length === 1) {
    return { layout: circuitLayouts[0], issue: null };
  }

  // More than one layout for this circuit — need the round's own layout
  // name to know which one it actually ran.
  if (!roundLayout) {
    return {
      layout: null,
      issue: `"${circuit.name}" has multiple layouts on file and this round has no layout recorded to tell them apart — set this round's layout (curated_rounds.layout).`,
    };
  }
  const targetLayout = normalize(roundLayout);
  const match = circuitLayouts.find((l) => normalize(l.name) === targetLayout) ?? null;
  if (!match) {
    return {
      layout: null,
      issue: `This round's layout ("${roundLayout}") doesn't match any of "${circuit.name}"'s layouts in Admin → Circuits.`,
    };
  }
  return { layout: match, issue: null };
}

export async function computeRoundRecap(env: SupabaseEnv, subsessionId: number): Promise<RoundRecap | null> {
  const [round, rawResults, penalties, classes, circuits, layouts, bestLapRows, roundLayout] = await Promise.all([
    getRoundBySubsessionId(env, subsessionId),
    getRoundResults(env, subsessionId),
    getPenaltiesForSubsession(env, subsessionId),
    getDriverClasses(env),
    getCircuits(env),
    getAllCircuitLayouts(env),
    fetchBestLaps(env, subsessionId),
    fetchRoundLayout(env, subsessionId),
  ]);
  if (!round) return null;

  // Same penalty recalculation every other results view uses — a recap
  // built off pre-penalty data would show a driver's finish/points as if
  // nothing had ever been logged against them.
  const classPointsEligibleByClassId = new Map(classes.map((c) => [c.id, c.name !== 'Alpha']));
  const roundResults: RoundResults =
    penalties.length > 0
      ? applyPenaltiesToRoundResults(rawResults, penalties, round.format, classPointsEligibleByClassId)
      : rawResults;

  const classNameById = new Map(classes.map((c) => [c.id, c.name]));
  const orderedClassIds = classes.map((c) => c.id);
  const raceNumbers = [...roundResults.overall.keys()].sort((a, b) => a - b);
  const { layout: matchedLayout, issue: trackRecordMatchIssue } = matchCircuitLayout(
    round.track_name,
    roundLayout,
    circuits,
    layouts
  );

  // cust_id -> driver, built once from the round's own results — best_lap
  // rows are keyed by cust_id (iRacing's own id, same as the rest of
  // curated_race_results), not this app's driver uuid.
  const driverByCustId = new Map<number, DriverBasic>();
  for (const rows of roundResults.overall.values()) {
    for (const row of rows) {
      if (row.driver.iracing_cust_id !== null) driverByCustId.set(row.driver.iracing_cust_id, row.driver);
    }
  }
  const bestLapsByRace = new Map<number, RawBestLapRow[]>();
  for (const r of bestLapRows) {
    if (!bestLapsByRace.has(r.race_number)) bestLapsByRace.set(r.race_number, []);
    bestLapsByRace.get(r.race_number)!.push(r);
  }

  const races: RecapRace[] = raceNumbers.map((raceNumber) => {
    const overallRows = roundResults.overall.get(raceNumber) ?? [];

    const topByClass: RecapClassTop3[] = orderedClassIds
      .map((classId): RecapClassTop3 | null => {
        const rows = (roundResults.byClass.get(classId)?.get(raceNumber) ?? [])
          .filter((r) => !r.dsq && r.position !== null)
          .sort((a, b) => (a.position as number) - (b.position as number))
          .slice(0, 3);
        if (rows.length === 0) return null;
        return {
          classId,
          className: classNameById.get(classId) ?? 'Class',
          top3: rows.map((r) => ({
            position: r.position as number,
            driver: r.driver,
            teamName: r.team?.name ?? null,
            teamLogoUrl: r.team?.logoUrl ?? null,
          })),
        };
      })
      .filter((x): x is RecapClassTop3 => x !== null);

    const topRookies: RecapRookieEntry[] = overallRows
      .filter((r) => r.driver.is_rookie && !r.dsq && r.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number))
      .slice(0, 3)
      .map((r) => ({ position: r.position, driver: r.driver }));

    // Fastest lap counts regardless of classification/DSQ — it's a raw
    // timing fact about that specific lap, not a scored result. Matched to
    // a driver via cust_id (see driverByCustId above) since fetchBestLaps()
    // reads straight off curated_race_results, keyed the same way the rest
    // of that external table is.
    let fastestLap: RecapFastestLap | null = null;
    const withLaps = (bestLapsByRace.get(raceNumber) ?? []).filter(
      (r) => r.best_lap_ten_thousandths !== null && r.best_lap_ten_thousandths > 0 && driverByCustId.has(r.cust_id)
    );
    if (withLaps.length > 0) {
      const best = withLaps.reduce((min, r) => (r.best_lap_ten_thousandths! < min.best_lap_ten_thousandths! ? r : min));
      const bestSeconds = best.best_lap_ten_thousandths! / 10000;
      const recordSeconds = matchedLayout?.lap_record_seconds ?? null;
      fastestLap = {
        driver: driverByCustId.get(best.cust_id)!,
        formatted: formatLapTime(bestSeconds),
        isTrackRecord: recordSeconds !== null && bestSeconds < recordSeconds,
        previousRecordFormatted: recordSeconds !== null ? formatLapTime(recordSeconds) : null,
      };
    }

    // "Sublime Finesse" — every driver actually awarded the finesse bonus
    // this race (an all-or-nothing per-driver bonus, so this lists everyone
    // who earned it, not a top-N).
    const sublimeFinesse: RecapFinesseEntry[] = overallRows
      .filter((r) => !r.dsq && r.incidentsBonus)
      .map((r) => ({ driver: r.driver, carNumber: r.driver.car_number, incidents: r.incidents }));

    // "Naked Aggression" — top 5 position gainers this race, whole field
    // (every class combined), by raw starting/finish position (not the
    // penalty-adjusted classification) — this is about who actually drove
    // through the field on track, independent of any post-race stewarding.
    const nakedAggression: RecapOvertakeEntry[] = overallRows
      .filter((r) => !r.dsq && r.startingPosition !== null)
      .map((r) => ({
        driver: r.driver,
        carNumber: r.driver.car_number,
        startingPosition: r.startingPosition as number,
        finishPosition: r.finishPosition,
        positionsGained: (r.startingPosition as number) - r.finishPosition,
      }))
      .sort((a, b) => b.positionsGained - a.positionsGained)
      .slice(0, 5);

    return { raceNumber, topByClass, topRookies, fastestLap, sublimeFinesse, nakedAggression };
  });

  // Team points — "which team scored the most overall points" (every class
  // combined) and "which [Delta] team scored the most [Delta] points"
  // (Delta-class rows only, matching Delta's own separate class_points
  // bonus — see results.ts's header on why Delta/Gamma aren't folded into
  // the overall total). Grouped by team NAME rather than an id, same as
  // every other results view already does (RaceResultRow.team has no id,
  // just {name, logoUrl} — see results.ts).
  //
  // Only each team's top 2 scorers in a given race actually count toward
  // that team's points for that race (topTeamScorers() — see its own doc
  // comment in results.ts) — a team that started 3 drivers in the same race
  // only ever gets 2 of those results added to its total, never all 3.
  const deltaClassId = classes.find((c) => c.name.toLowerCase() === 'delta')?.id ?? null;

  interface TeamAgg {
    name: string;
    logoUrl: string | null;
    points: number;
  }
  const overallByTeam = new Map<string, TeamAgg>();
  const deltaByTeam = new Map<string, TeamAgg>();
  const breakdownByTeam = new Map<string, RecapTeamBreakdown>();
  const deltaBreakdownByTeam = new Map<string, RecapTeamBreakdown>();

  const overallPointsOf = (row: RaceResultRow) => row.totalPoints - row.classPoints;
  const deltaPointsOf = (row: RaceResultRow) => row.totalPoints;

  function addEntry(map: Map<string, RecapTeamBreakdown>, row: RaceResultRow, raceNumber: number, points: number) {
    const key = row.team!.name;
    if (!map.has(key)) map.set(key, { teamName: key, logoUrl: row.team!.logoUrl, entries: [] });
    map.get(key)!.entries.push({
      raceNumber,
      driverName: row.driver.name,
      carNumber: row.driver.car_number,
      points,
      nationality1: row.driver.nationality_1,
      nationality2: row.driver.nationality_2,
    });
  }

  for (const raceNumber of raceNumbers) {
    const rows = roundResults.overall.get(raceNumber) ?? [];

    const rowsByTeam = new Map<string, RaceResultRow[]>();
    for (const row of rows) {
      if (!row.team) continue;
      const key = row.team.name;
      if (!rowsByTeam.has(key)) rowsByTeam.set(key, []);
      rowsByTeam.get(key)!.push(row);
    }

    for (const teamRows of rowsByTeam.values()) {
      for (const row of topTeamScorers(teamRows, overallPointsOf)) {
        const key = row.team!.name;
        const points = overallPointsOf(row);
        if (!overallByTeam.has(key)) overallByTeam.set(key, { name: key, logoUrl: row.team!.logoUrl, points: 0 });
        overallByTeam.get(key)!.points += points;
        addEntry(breakdownByTeam, row, raceNumber, points);
      }

      if (deltaClassId !== null) {
        const deltaRows = teamRows.filter((r) => r.classId === deltaClassId);
        for (const row of topTeamScorers(deltaRows, deltaPointsOf)) {
          const key = row.team!.name;
          const points = deltaPointsOf(row);
          if (!deltaByTeam.has(key)) deltaByTeam.set(key, { name: key, logoUrl: row.team!.logoUrl, points: 0 });
          deltaByTeam.get(key)!.points += points;
          addEntry(deltaBreakdownByTeam, row, raceNumber, points);
        }
      }
    }
  }

  function topTeam(m: Map<string, TeamAgg>): RecapTeamPoints | null {
    let best: TeamAgg | null = null;
    for (const t of m.values()) {
      if (!best || t.points > best.points) best = t;
    }
    return best ? { teamName: best.name, logoUrl: best.logoUrl, points: best.points } : null;
  }

  const teamBreakdown = [...breakdownByTeam.values()].sort((a, b) => a.teamName.localeCompare(b.teamName));
  const deltaTeamBreakdown = [...deltaBreakdownByTeam.values()].sort((a, b) => a.teamName.localeCompare(b.teamName));
  for (const t of [...teamBreakdown, ...deltaTeamBreakdown]) {
    t.entries.sort((a, b) => a.raceNumber - b.raceNumber || (a.carNumber ?? Infinity) - (b.carNumber ?? Infinity));
  }

  return {
    subsessionId,
    trackName: round.track_name,
    races,
    topTeamOverall: topTeam(overallByTeam),
    topTeamDelta: topTeam(deltaByTeam),
    teamBreakdown,
    deltaTeamBreakdown,
    trackRecordMatchIssue,
  };
}
