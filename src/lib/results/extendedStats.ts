import { restGetAll, type SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import type { Season } from '../db/seasons';
import { getCircuits, getAllCircuitLayouts, type Circuit, type CircuitLayout } from '../db/circuits';
import { effectivePenaltyPoints } from '../penalties/effective';
import { isChampionshipSeason } from './shared';
import {
  getCuratedRaceResultsForSubsessions,
  getLapStatsForSubsessions,
  driversSelect,
  resultKey,
  type CuratedRaceResultRow,
  type RawLapStatsRow,
  type DriverBasic,
} from './rows';
import { getSeasonOverallContext, type SeasonOverallContext } from './seasonContext';
import { resolveLayout } from './layouts';
import { getRoundLayoutsForSubsessions } from './layoutLaps';

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
  /** Per-round breakdown of the figures above — feeds the "Standings by Round" slider's as-of detail panel. Keyed by subsession_id. `km`/`corners` are null for a round whose layout couldn't be matched (same "nothing resolved" rule as distanceKm/cornersPerIncident). Penalty points can exist for a round the driver didn't score in. */
  byRound: Map<number, ExtendedRoundStat>;
}

export interface ExtendedRoundStat {
  laps: number;
  lapsLed: number;
  netPositionsChange: number;
  incidents: number;
  penaltyPoints: number;
  bonusPoints: number;
  km: number | null;
  corners: number | null;
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
export async function getCuratedRaceResultsWithLapStatsBulk(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<{ rawResults: CuratedRaceResultRow[]; lapStats: RawLapStatsRow[] }> {
  if (subsessionIds.length === 0) return { rawResults: [], lapStats: [] };
  const combinedSelect =
    'subsession_id,race_number,cust_id,finish_position,starting_position,adjusted_position,incidents,laps_complete,laps_led,car_name,interval_ten_thousandths,average_lap_ten_thousandths,best_lap_ten_thousandths';
  try {
    const rows = await restGetAll<CuratedRaceResultRow & RawLapStatsRow>(
      env,
      `curated_race_results?select=${combinedSelect}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc,race_number.asc,cust_id.asc`,
    );
    return { rawResults: rows, lapStats: rows };
  } catch (err) {
    console.error(
      'Combined curated_race_results+lap-stats bulk query failed — falling back to the two separate isolated queries:',
      err,
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
  roundLayoutsLookup?: Map<number, string | null>,
): Promise<Map<string, DriverSeasonExtendedStats>> {
  if (!isChampionshipSeason(season.name)) return new Map();

  const [drivers, exhibitionIds] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env),
    exhibitionRoundIds ? Promise.resolve(exhibitionRoundIds) : getStandingsExcludedRoundIds(env),
  ]);

  const overallContext =
    precomputedOverallContext ?? (await getSeasonOverallContext(env, season, exhibitionIds, drivers));
  const scores = overallContext.overallScores;
  if (scores.length === 0) return new Map();

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];
  const [circuits, layouts, roundLayouts] = await Promise.all([
    circuitsLookup
      ? Promise.resolve(circuitsLookup)
      : getCircuits(env).catch((err) => {
          console.error(
            'Failed to fetch circuits for season distance-driven/corners-per-incident stats — both will be omitted:',
            err,
          );
          return [] as Circuit[];
        }),
    layoutsLookup
      ? Promise.resolve(layoutsLookup)
      : getAllCircuitLayouts(env).catch((err) => {
          console.error(
            'Failed to fetch circuit_layouts for season distance-driven/corners-per-incident stats — both will be omitted:',
            err,
          );
          return [] as CircuitLayout[];
        }),
    roundLayoutsLookup
      ? Promise.resolve(roundLayoutsLookup)
      : getRoundLayoutsForSubsessions(env, subsessionIds),
  ]);
  // seasonRounds comes straight off the shared context now (same
  // curated_rounds fetch getSeasonOverallContext already made for
  // formatBySubsession) instead of a second getRoundsForSeason call.
  const trackNameBySubsession = new Map(
    overallContext.seasonRounds.map((r) => [r.subsession_id, r.track_name]),
  );
  const kmBySubsession = new Map<number, number | null>();
  const cornersBySubsession = new Map<number, number | null>();
  for (const subsessionId of subsessionIds) {
    const trackName = trackNameBySubsession.get(subsessionId);
    const layout = trackName
      ? resolveLayout(trackName, roundLayouts.get(subsessionId) ?? null, circuits, layouts)
      : null;
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
    byRound: Map<number, ExtendedRoundStat>;
  }
  const accum = new Map<string, ExtendedAccum>();
  function extRound(a: ExtendedAccum, subsessionId: number): ExtendedRoundStat {
    let r = a.byRound.get(subsessionId);
    if (!r) {
      r = {
        laps: 0,
        lapsLed: 0,
        netPositionsChange: 0,
        incidents: 0,
        penaltyPoints: 0,
        bonusPoints: 0,
        km: kmBySubsession.get(subsessionId) ?? null,
        corners: cornersBySubsession.get(subsessionId) ?? null,
      };
      a.byRound.set(subsessionId, r);
    }
    return r;
  }
  function getAccum(driverId: string): ExtendedAccum {
    let a = accum.get(driverId);
    if (!a) {
      a = {
        laps: 0,
        lapsLed: 0,
        netPositionsChange: 0,
        incidents: 0,
        penaltyPoints: 0,
        bonusPoints: 0,
        distanceKm: 0,
        totalCorners: 0,
        byRound: new Map(),
      };
      accum.set(driverId, a);
    }
    return a;
  }

  for (const s of scores) {
    const a = getAccum(s.driver_id);
    a.bonusPoints += s.finesse_bonus + s.pole_bonus;
    const er = extRound(a, s.subsession_id);
    er.bonusPoints += s.finesse_bonus + s.pole_bonus;

    const custId = overallContext.custIdByDriverId.get(s.driver_id);
    const raw =
      custId != null
        ? overallContext.rawByKey.get(resultKey(s.subsession_id, s.race_number, custId))
        : undefined;
    if (!raw) continue;
    a.laps += raw.laps_complete ?? 0;
    a.lapsLed += raw.laps_led ?? 0;
    a.incidents += raw.incidents ?? 0;
    er.laps += raw.laps_complete ?? 0;
    er.lapsLed += raw.laps_led ?? 0;
    er.incidents += raw.incidents ?? 0;

    const finalPosition = raw.adjusted_position ?? raw.finish_position;
    if (raw.starting_position !== null && finalPosition !== null) {
      a.netPositionsChange += raw.starting_position - finalPosition;
      er.netPositionsChange += raw.starting_position - finalPosition;
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
    extRound(a, p.subsession_id).penaltyPoints += effectivePenaltyPoints(p);
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
      byRound: a.byRound,
    });
  }
  return out;
}
