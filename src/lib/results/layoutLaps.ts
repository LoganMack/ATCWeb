import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import { getCarLogos, type CarLogo } from '../db/assets';
import type { Circuit, CircuitLayout } from '../db/circuits';
import { LEAGUE_TIME_ZONE } from '../timezone';
import { driversSelect, type DriverBasic, type RoundSummary } from './rows';
import {
  resolveRoundLayoutKey,
  resolveEventLayoutKey,
  type LayoutRoundSummary,
  type LayoutMatchKey,
} from './layouts';

export interface ClassBestLap {
  classId: number;
  seconds: number;
  driver: DriverBasic;
  subsessionId: number;
  /** The round's start_time this lap was set in — `curated_rounds.start_time`, same field LayoutRoundSummary.startTime carries. */
  date: string;
  /** `curated_race_results.car_name` for this exact (subsession_id, driver) row — the car actually driven to set this lap, not whatever the driver drives today. Null on the rare row with no car_name on file. */
  carName: string | null;
  /** car_logos lookup for carName (0009_car_logos.sql, admin-curated, keyed by car_name text) — null when carName is null or has no logo on file. */
  carLogoUrl: string | null;
}

/**
 * Fastest lap ever at one circuit+layout, per class, for the Event Briefing's Track Record section. Class is
 * read per round, not from today's roster, and every race counts, not just race 1.
 */
export async function getLayoutClassBestLaps(
  env: SupabaseEnv,
  rounds: LayoutRoundSummary[],
  driversBasic?: DriverBasic[],
  /** See getSeasonCarTeamStats' identical param — pass a pre-fetched car_logos list to skip this function's own fetch. */
  carLogosLookup?: CarLogo[],
): Promise<Map<number, ClassBestLap>> {
  const bestByClass = new Map<number, ClassBestLap>();
  if (rounds.length === 0) return bestByClass;

  const subsessionIds = rounds.map((r) => r.subsessionId);
  const roundBySubsession = new Map(rounds.map((r) => [r.subsessionId, r]));

  const [drivers, carLogos, raceRows, scoreRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env, { includeAi: true }),
    carLogosLookup ? Promise.resolve(carLogosLookup) : getCarLogos(env),
    restGetAll<{
      subsession_id: number;
      cust_id: number;
      best_lap_ten_thousandths: number | null;
      car_name: string | null;
    }>(
      env,
      `curated_race_results?select=subsession_id,cust_id,best_lap_ten_thousandths,car_name&subsession_id=in.(${subsessionIds.join(',')})&best_lap_ten_thousandths=not.is.null`,
    ),
    restGetAll<{ subsession_id: number; driver_id: string; class_id: number }>(
      env,
      `race_score_results_public?select=subsession_id,driver_id,class_id&subsession_id=in.(${subsessionIds.join(',')})`,
    ),
  ]);

  const driverByCustId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.iracing_cust_id as number, d]),
  );
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  // First class_id seen per (subsession, driver) — same "class doesn't
  // change race-to-race within one round" reasoning as every other
  // per-round class lookup in this file.
  const classIdBySubDriver = new Map<string, number>();
  for (const s of scoreRows) {
    const key = `${s.subsession_id}:${s.driver_id}`;
    if (!classIdBySubDriver.has(key)) classIdBySubDriver.set(key, s.class_id);
  }

  for (const row of raceRows) {
    if (row.best_lap_ten_thousandths === null) continue;
    const round = roundBySubsession.get(row.subsession_id);
    if (!round) continue;
    const driver = driverByCustId.get(row.cust_id);
    if (!driver) continue;
    const classId = classIdBySubDriver.get(`${row.subsession_id}:${driver.id}`);
    if (classId === undefined) continue;
    const seconds = row.best_lap_ten_thousandths / 10000;
    const existing = bestByClass.get(classId);
    if (!existing || seconds < existing.seconds) {
      bestByClass.set(classId, {
        classId,
        seconds,
        driver,
        subsessionId: row.subsession_id,
        date: round.startTime,
        carName: row.car_name,
        carLogoUrl: row.car_name ? (carLogoByName.get(row.car_name) ?? null) : null,
      });
    }
  }

  return bestByClass;
}

export interface ResolvedLapRecordCar {
  carName: string;
  carLogoUrl: string | null;
}

/**
 * Best-effort match of the admin-typed lap record back to the race result it came from, to show its car logo.
 * It looks for the closest lap within a small tolerance (the record was typed with 3 decimals, results store
 * 4) on the record's date, then at any date. Null is the normal answer for records older than ATC's imported
 * results or from outside the league.
 */
export async function resolveLapRecordCar(
  env: SupabaseEnv,
  layoutRow: Pick<CircuitLayout, 'lap_record_seconds' | 'lap_record_date'>,
  historicalRounds: LayoutRoundSummary[],
  carLogosLookup?: CarLogo[],
): Promise<ResolvedLapRecordCar | null> {
  if (layoutRow.lap_record_seconds === null || historicalRounds.length === 0) return null;

  const etDate = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: LEAGUE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));

  const dateMatches = layoutRow.lap_record_date
    ? historicalRounds.filter((r) => etDate(r.startTime) === layoutRow.lap_record_date)
    : [];
  const candidateRounds = dateMatches.length > 0 ? dateMatches : historicalRounds;
  const subsessionIds = candidateRounds.map((r) => r.subsessionId);

  const [rows, carLogos] = await Promise.all([
    restGetAll<{ subsession_id: number; best_lap_ten_thousandths: number | null; car_name: string | null }>(
      env,
      `curated_race_results?select=subsession_id,best_lap_ten_thousandths,car_name&subsession_id=in.(${subsessionIds.join(',')})&best_lap_ten_thousandths=not.is.null&car_name=not.is.null`,
    ),
    carLogosLookup ? Promise.resolve(carLogosLookup) : getCarLogos(env),
  ]);

  const TOLERANCE_SECONDS = 0.002;
  let best: { carName: string; diff: number } | null = null;
  for (const row of rows) {
    if (row.best_lap_ten_thousandths === null || !row.car_name) continue;
    const diff = Math.abs(row.best_lap_ten_thousandths / 10000 - layoutRow.lap_record_seconds);
    if (diff > TOLERANCE_SECONDS) continue;
    if (!best || diff < best.diff) best = { carName: row.car_name, diff };
  }
  if (!best) return null;

  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  return { carName: best.carName, carLogoUrl: carLogoByName.get(best.carName) ?? null };
}

/**
 * A `(circuitId, eventLayoutName) -> count` lookup for the calendar's "Race Recaps at this Layout (N)"
 * badges. Each round's match key is resolved once, so the cost grows with rounds + events instead of rounds ×
 * events, which stays inside the Workers Free plan CPU limit.
 */
export function buildLayoutRoundCounter(
  allRounds: RoundSummary[],
  roundLayoutBySubsession: Map<number, string | null>,
  circuits: Circuit[],
  layouts: CircuitLayout[],
): (circuitId: string, eventLayoutName: string | null) => number {
  const keyStr = (key: LayoutMatchKey) => `${key.kind}:${key.id}`;
  const countByKey = new Map<string, number>();
  for (const r of allRounds) {
    const key = resolveRoundLayoutKey(
      r.track_name,
      roundLayoutBySubsession.get(r.subsession_id) ?? null,
      circuits,
      layouts,
    );
    if (!key) continue;
    const k = keyStr(key);
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
  }
  return (circuitId, eventLayoutName) => {
    const key = resolveEventLayoutKey(circuitId, eventLayoutName, layouts);
    return countByKey.get(keyStr(key)) ?? 0;
  };
}

/**
 * Site-wide getLayoutClassBestLaps for circuits.astro, which shows every layout: rounds are resolved once and
 * the per-class minimum lap is bucketed per layout, from two whole-table fetches.
 */
export async function buildLayoutClassBestLaps(
  env: SupabaseEnv,
  allRounds: RoundSummary[],
  roundLayoutBySubsession: Map<number, string | null>,
  circuits: Circuit[],
  layouts: CircuitLayout[],
  driversBasic?: DriverBasic[],
  /** See getSeasonCarTeamStats' identical param — pass a pre-fetched car_logos list to skip this function's own fetch. */
  carLogosLookup?: CarLogo[],
): Promise<(circuitId: string, eventLayoutName: string | null) => Map<number, ClassBestLap>> {
  const [drivers, carLogos, raceRows, scoreRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env, { includeAi: true }),
    carLogosLookup ? Promise.resolve(carLogosLookup) : getCarLogos(env),
    restGetAll<{
      subsession_id: number;
      cust_id: number;
      best_lap_ten_thousandths: number | null;
      car_name: string | null;
    }>(
      env,
      `curated_race_results?select=subsession_id,cust_id,best_lap_ten_thousandths,car_name&best_lap_ten_thousandths=not.is.null`,
    ),
    restGetAll<{ subsession_id: number; driver_id: string; class_id: number }>(
      env,
      `race_score_results_public?select=subsession_id,driver_id,class_id`,
    ),
  ]);

  const driverByCustId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.iracing_cust_id as number, d]),
  );
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  const roundBySubsession = new Map(allRounds.map((r) => [r.subsession_id, r]));
  const classIdBySubDriver = new Map<string, number>();
  for (const s of scoreRows) {
    const key = `${s.subsession_id}:${s.driver_id}`;
    if (!classIdBySubDriver.has(key)) classIdBySubDriver.set(key, s.class_id);
  }

  const keyStr = (key: LayoutMatchKey) => `${key.kind}:${key.id}`;
  const bestByLayoutKeyClass = new Map<string, Map<number, ClassBestLap>>();

  for (const row of raceRows) {
    if (row.best_lap_ten_thousandths === null) continue;
    const round = roundBySubsession.get(row.subsession_id);
    if (!round) continue;
    const driver = driverByCustId.get(row.cust_id);
    if (!driver) continue;
    const classId = classIdBySubDriver.get(`${row.subsession_id}:${driver.id}`);
    if (classId === undefined) continue;
    const layoutKey = resolveRoundLayoutKey(
      round.track_name,
      roundLayoutBySubsession.get(row.subsession_id) ?? null,
      circuits,
      layouts,
    );
    if (!layoutKey) continue;
    const lk = keyStr(layoutKey);
    let byClass = bestByLayoutKeyClass.get(lk);
    if (!byClass) {
      byClass = new Map();
      bestByLayoutKeyClass.set(lk, byClass);
    }
    const seconds = row.best_lap_ten_thousandths / 10000;
    const existing = byClass.get(classId);
    if (!existing || seconds < existing.seconds) {
      byClass.set(classId, {
        classId,
        seconds,
        driver,
        subsessionId: row.subsession_id,
        date: round.start_time,
        carName: row.car_name,
        carLogoUrl: row.car_name ? (carLogoByName.get(row.car_name) ?? null) : null,
      });
    }
  }

  return (circuitId, eventLayoutName) => {
    const key = resolveEventLayoutKey(circuitId, eventLayoutName, layouts);
    return bestByLayoutKeyClass.get(keyStr(key)) ?? new Map();
  };
}

/** Batched version of newsRecap.ts's fetchRoundLayout — one query for every round in the season instead of one per round. Same graceful-degradation-on-failure reasoning (this is a small admin-filled column that may not exist/be filled in for every round). */
export async function getRoundLayoutsForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<Map<number, string | null>> {
  if (subsessionIds.length === 0) return new Map();
  try {
    // restGetAll because a whole-career call can pass hundreds of subsession_ids; subsession_id is unique
    // here, so it is a stable sort.
    const rows = await restGetAll<{ subsession_id: number; layout: string | null }>(
      env,
      `curated_rounds?select=subsession_id,layout&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc`,
    );
    return new Map(rows.map((r) => [r.subsession_id, r.layout]));
  } catch (err) {
    console.error(
      'Failed to fetch curated_rounds.layout for season distance-driven stats — distance will be omitted:',
      err,
    );
    return new Map();
  }
}

/**
 * Subsessions run at a track (optionally one layout), matched on curated_rounds names directly: the full
 * layout resolution needs whole tables, too costly for the nav's "Happening Now" banner. Falls back to the
 * track alone, then a case-insensitive track match.
 */
async function findSubsessionIdsForTrack(
  env: SupabaseEnv,
  trackName: string,
  layoutName: string | null,
): Promise<number[]> {
  const encTrack = encodeURIComponent(trackName);
  if (layoutName) {
    const withLayout = await restGetAll<{ subsession_id: number }>(
      env,
      `curated_rounds?select=subsession_id&track_name=eq.${encTrack}&layout=eq.${encodeURIComponent(layoutName)}`,
    );
    if (withLayout.length > 0) return withLayout.map((r) => r.subsession_id);
  }
  const anyLayout = await restGetAll<{ subsession_id: number }>(
    env,
    `curated_rounds?select=subsession_id&track_name=eq.${encTrack}`,
  );
  if (anyLayout.length > 0) return anyLayout.map((r) => r.subsession_id);
  const caseInsensitive = await restGetAll<{ subsession_id: number }>(
    env,
    `curated_rounds?select=subsession_id&track_name=ilike.${encTrack}`,
  );
  return caseInsensitive.map((r) => r.subsession_id);
}

/**
 * Fastest lap ever at a track (optionally one layout), in seconds, for the "Happening Now" banner's estimate
 * of a final race's length (lap count × (this + 5 s)). Null on failure or with no history; the caller then
 * assumes a flat duration.
 */
export async function getLayoutBestLapSeconds(
  env: SupabaseEnv,
  trackName: string | null,
  layoutName: string | null,
): Promise<number | null> {
  if (!trackName) return null;
  try {
    const subsessionIds = await findSubsessionIdsForTrack(env, trackName, layoutName);
    if (subsessionIds.length === 0) return null;
    const rows = await restGet<{ best_lap_ten_thousandths: number | null }[]>(
      env,
      `curated_race_results?select=best_lap_ten_thousandths&subsession_id=in.(${subsessionIds.join(',')})&best_lap_ten_thousandths=not.is.null&order=best_lap_ten_thousandths.asc&limit=1`,
    );
    const best = rows[0]?.best_lap_ten_thousandths;
    return best ? best / 10000 : null;
  } catch (err) {
    console.error(
      'Failed to look up historical best lap time for the "Happening Now" nav banner\'s race-duration estimate:',
      err,
    );
    return null;
  }
}

/**
 * Each driver's fastest lap at a track, excluding one round, for the results page's personal-best marker
 * (Logan). Bounded to this track and these drivers to stay under the subrequest limit; returns an empty map
 * on failure.
 */
export async function getDriverBestLapsAtTrack(
  env: SupabaseEnv,
  trackName: string,
  layoutName: string | null,
  driverIds: string[],
  excludeSubsessionId: number,
  driversBasic?: DriverBasic[],
): Promise<Map<string, number>> {
  const best = new Map<string, number>();
  if (driverIds.length === 0) return best;

  const [subsessionIds, drivers] = await Promise.all([
    findSubsessionIdsForTrack(env, trackName, layoutName),
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env, { includeAi: true }),
  ]);
  const otherSubsessionIds = subsessionIds.filter((id) => id !== excludeSubsessionId);
  if (otherSubsessionIds.length === 0) return best;

  const driverIdSet = new Set(driverIds);
  const driverIdByCustId = new Map<number, string>();
  for (const d of drivers) {
    if (d.iracing_cust_id == null || !driverIdSet.has(d.id)) continue;
    driverIdByCustId.set(d.iracing_cust_id, d.id);
  }
  const custIds = [...driverIdByCustId.keys()];
  if (custIds.length === 0) return best;

  const rows = await restGetAll<{ cust_id: number; best_lap_ten_thousandths: number | null }>(
    env,
    `curated_race_results?select=cust_id,best_lap_ten_thousandths&subsession_id=in.(${otherSubsessionIds.join(',')})&cust_id=in.(${custIds.join(',')})&best_lap_ten_thousandths=not.is.null`,
  );
  for (const row of rows) {
    if (row.best_lap_ten_thousandths === null) continue;
    const driverId = driverIdByCustId.get(row.cust_id);
    if (!driverId) continue;
    const existing = best.get(driverId);
    if (existing === undefined || row.best_lap_ten_thousandths < existing) {
      best.set(driverId, row.best_lap_ten_thousandths);
    }
  }
  return best;
}
