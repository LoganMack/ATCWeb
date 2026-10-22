/**
 * The race recap for a news post linked to a round (0017): top 3 per class, top rookies, fastest lap with a
 * track record check, and team points, per race. Computed at render time from the same penalty-adjusted data
 * as the results page, so later penalties show without regenerating. The track record match is exact on
 * normalised names (Logan); when it fails, `trackRecordMatchIssue` explains why to admins only.
 */

import { restGet, type SupabaseEnv } from './db/client';
import { getDriverClasses } from './db/lookups';
import {
  getCircuits,
  getAllCircuitLayouts,
  formatLapTime,
  type Circuit,
  type CircuitLayout,
} from './db/circuits';
import { getRoundBySubsessionId } from './results/rounds';
import { getRoundResults, type RaceResultRow } from './results/roundResults';
import { topTeamScorers } from './results/seasonCarTeam';
import type { DriverBasic } from './results/rows';

interface RawBestLapRow {
  race_number: number;
  cust_id: number;
  best_lap_ten_thousandths: number | null;
}

/**
 * Fastest-lap data in its own query and try/catch, kept out of the shared results query: PostgREST fails a
 * whole query on a missing column, so this can only drop the recap's fastest lap.
 */
async function fetchBestLaps(env: SupabaseEnv, subsessionId: number): Promise<RawBestLapRow[]> {
  try {
    return await restGet<RawBestLapRow[]>(
      env,
      `curated_race_results?select=race_number,cust_id,best_lap_ten_thousandths&subsession_id=eq.${subsessionId}`,
    );
  } catch (err) {
    console.error('News recap: failed to fetch fastest-lap data, omitting that stat:', err);
    return [];
  }
}

/**
 * The round's `layout` (a column this repo added to the pipeline's curated_rounds, 0018), isolated like
 * fetchBestLaps(). Null for rounds without it; matchCircuitLayout() copes.
 */
async function fetchRoundLayout(env: SupabaseEnv, subsessionId: number): Promise<string | null> {
  try {
    const rows = await restGet<{ layout: string | null }[]>(
      env,
      `curated_rounds?select=layout&subsession_id=eq.${subsessionId}`,
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

/** One driver who was awarded the "Sublime Finesse" bonus (finesse_bonus > 0 — "3 incidents or less" that race). */
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
  /** True when this driver actually earned the Naked Aggression bonus POINT this race (its shown_aggression_bonus > 0 — the single best net gain that race, shared by every driver tied for it) — mirrors RaceResultRow.aggressionBonusWon. Distinct from just being ranked in this top-5 list: a driver can lead this list without the eligibility this bonus requires (classified, not DSQ'd, a real starting position — see score_round()), or several drivers can share the win at once. */
  bonusAwarded: boolean;
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
  driverId: string;
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
  /**
   * Highest Delta-class team points this round (Delta has its own class_points); null with no Delta field or
   * no team.
   */
  topTeamDelta: RecapTeamPoints | null;
  /** Every team's top-2-per-race scorers (see topTeamScorers()), with which driver scored what in which race — sorted by team name. */
  teamBreakdown: RecapTeamBreakdown[];
  /** Same idea as `teamBreakdown`, but scoped to just Delta-class rows and ranked/summed by each row's full totalPoints (Delta's own class_points bonus included) — mirrors topTeamDelta. Empty when this round had no Delta class field. */
  deltaTeamBreakdown: RecapTeamBreakdown[];
  /**
   * Why the track/layout couldn't be matched to a circuit_layouts row, shown only to admins on the article so
   * it can be fixed in Admin → Circuits.
   */
  trackRecordMatchIssue: string | null;
}

// Kept in sync with normalizeTrackOrLayoutName in src/lib/results/layouts.ts, which can't be imported here
// (cycle). Strips "[Retired] " (no separate circuits rows) but not "[Legacy] " (those are distinct layouts).
function normalize(s: string): string {
  const withoutRetiredTag = s.replace(/^\[retired\]\s*/i, '');
  return withoutRetiredTag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface LayoutMatchResult {
  layout: CircuitLayout | null;
  /** Non-null exactly when layout is null — see RoundRecap.trackRecordMatchIssue. */
  issue: string | null;
}

/**
 * Matches a round's track_name, and layout when the circuit has several, to one circuit_layouts row by exact
 * normalised name (Logan: track names are consistent). Returns an admin-only `issue` instead of guessing.
 */
function matchCircuitLayout(
  trackName: string,
  roundLayout: string | null,
  circuits: Circuit[],
  layouts: CircuitLayout[],
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
  const [round, roundResults, classes, circuits, layouts, bestLapRows, roundLayout] = await Promise.all([
    getRoundBySubsessionId(env, subsessionId),
    getRoundResults(env, subsessionId),
    getDriverClasses(env),
    getCircuits(env),
    getAllCircuitLayouts(env),
    fetchBestLaps(env, subsessionId),
    fetchRoundLayout(env, subsessionId),
  ]);
  if (!round) return null;

  const classNameById = new Map(classes.map((c) => [c.id, c.name]));
  const orderedClassIds = classes.map((c) => c.id);
  const raceNumbers = [...roundResults.overall.keys()].sort((a, b) => a - b);
  const { layout: matchedLayout, issue: trackRecordMatchIssue } = matchCircuitLayout(
    round.track_name,
    roundLayout,
    circuits,
    layouts,
  );

  // cust_id -> driver, since best-lap rows are keyed by cust_id. Unrostered rows are left out so they can't
  // get the Fastest Lap highlight.
  const driverByCustId = new Map<number, DriverBasic>();
  for (const rows of roundResults.overall.values()) {
    for (const row of rows) {
      if (!row.notInRoster && row.driver.iracing_cust_id !== null)
        driverByCustId.set(row.driver.iracing_cust_id, row.driver);
    }
  }
  const bestLapsByRace = new Map<number, RawBestLapRow[]>();
  for (const r of bestLapRows) {
    if (!bestLapsByRace.has(r.race_number)) bestLapsByRace.set(r.race_number, []);
    bestLapsByRace.get(r.race_number)!.push(r);
  }

  const races: RecapRace[] = raceNumbers.map((raceNumber) => {
    // Unrostered entrants are a data gap for an admin to fix (Sync Results with Roster), not names to feature
    // in a public post. byClass never contains them.
    const overallRows = (roundResults.overall.get(raceNumber) ?? []).filter((r) => !r.notInRoster);

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

    // Fastest lap ignores classification and DSQ: it's a timing fact, not a scored result.
    let fastestLap: RecapFastestLap | null = null;
    const withLaps = (bestLapsByRace.get(raceNumber) ?? []).filter(
      (r) =>
        r.best_lap_ten_thousandths !== null &&
        r.best_lap_ten_thousandths > 0 &&
        driverByCustId.has(r.cust_id),
    );
    if (withLaps.length > 0) {
      const best = withLaps.reduce((min, r) =>
        r.best_lap_ten_thousandths! < min.best_lap_ten_thousandths! ? r : min,
      );
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

    // "Naked Aggression": top 5 gainers by raw grid-to-finish positions across the whole field, independent
    // of stewarding. Whoever won the bonus point is always included, even past the cutoff in a tie.
    const rankedGainers: RecapOvertakeEntry[] = overallRows
      .filter((r) => !r.dsq && r.startingPosition !== null)
      .map((r) => ({
        driver: r.driver,
        carNumber: r.driver.car_number,
        startingPosition: r.startingPosition as number,
        finishPosition: r.finishPosition,
        positionsGained: (r.startingPosition as number) - r.finishPosition,
        bonusAwarded: r.aggressionBonusWon,
      }))
      .sort((a, b) => b.positionsGained - a.positionsGained);
    const nakedAggression: RecapOvertakeEntry[] = [
      ...rankedGainers.slice(0, 5),
      ...rankedGainers.slice(5).filter((r) => r.bonusAwarded),
    ];

    return { raceNumber, topByClass, topRookies, fastestLap, sublimeFinesse, nakedAggression };
  });

  // Team points overall and for Delta (rows only, with its own class points), grouped by team name as the
  // results views have no team id. Only each team's top 2 scorers per race count (topTeamScorers()).
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

  function addEntry(
    map: Map<string, RecapTeamBreakdown>,
    row: RaceResultRow,
    raceNumber: number,
    points: number,
  ) {
    const key = row.team!.name;
    if (!map.has(key)) map.set(key, { teamName: key, logoUrl: row.team!.logoUrl, entries: [] });
    map.get(key)!.entries.push({
      raceNumber,
      driverId: row.driver.id,
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
        if (!overallByTeam.has(key))
          overallByTeam.set(key, { name: key, logoUrl: row.team!.logoUrl, points: 0 });
        overallByTeam.get(key)!.points += points;
        addEntry(breakdownByTeam, row, raceNumber, points);
      }

      if (deltaClassId !== null) {
        const deltaRows = teamRows.filter((r) => r.classId === deltaClassId);
        for (const row of topTeamScorers(deltaRows, deltaPointsOf)) {
          const key = row.team!.name;
          const points = deltaPointsOf(row);
          if (!deltaByTeam.has(key))
            deltaByTeam.set(key, { name: key, logoUrl: row.team!.logoUrl, points: 0 });
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
  const deltaTeamBreakdown = [...deltaBreakdownByTeam.values()].sort((a, b) =>
    a.teamName.localeCompare(b.teamName),
  );
  for (const t of [...teamBreakdown, ...deltaTeamBreakdown]) {
    t.entries.sort(
      (a, b) => a.raceNumber - b.raceNumber || (a.carNumber ?? Infinity) - (b.carNumber ?? Infinity),
    );
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
