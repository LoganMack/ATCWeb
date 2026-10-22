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
 * Fastest lap ever recorded at one circuit+layout, broken down by class —
 * powers the Event Briefing page's expanded "Track Record" section (Gamma
 * and Delta bests, alongside the plain circuit_layouts.lap_record_seconds
 * figure that section already showed). Scoped to a specific, already-
 * resolved set of `rounds` (findRoundsForLayout()'s output for one layout)
 * rather than the whole site — see buildLayoutClassBestLaps just below for
 * the "every layout on one page" version circuits.astro needs instead, and
 * why the two aren't the same function.
 *
 * Class is resolved PER ROUND (`race_score_results.class_id` for that driver in
 * that specific subsession) — never off a driver's current/latest roster
 * class — so a driver who has since moved between classes doesn't
 * misattribute an old lap to whichever class they race today. Considers
 * every race (1/2/3), not just race 1 — unlike getLayoutClassHighlights'
 * winner/pole (each tied to one specific race), "fastest lap ever" isn't
 * scoped to any one race.
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
 * Best-effort match of circuit_layouts' admin-curated lap record
 * (lap_record_seconds/lap_record_date, both free-typed — see
 * 0013_circuit_layout_lap_record_seconds.sql) back to the actual
 * curated_race_results row it came from, so its car can be read off that
 * row and looked up in car_logos — same idea as getLayoutClassBestLaps'
 * Gamma/Delta lines just above, just applied to a pre-existing record
 * instead of one this file computes itself.
 *
 * Matching strategy: narrow to rounds at this layout on the record's own
 * date (America/New_York, matching every other "IRL" date on the site —
 * see LEAGUE_TIME_ZONE), then find whichever curated_race_results row's lap
 * time is closest to lap_record_seconds, within a small tolerance. The
 * tolerance (rather than exact equality) exists because lap_record_seconds
 * was typed in from a formatted "1:42.512" display (3 decimals) while
 * curated_race_results stores raw ten-thousandths (4 decimals) — an exact
 * check would miss real matches on rounding alone. Falls back to searching
 * every historical round at this layout (still lap-time-scoped, same
 * tolerance) when no round matches the date, in case the date was entered
 * slightly off or left unset — a coincidental collision within 2ms across
 * unrelated rounds is vanishingly unlikely.
 *
 * Returns null, with no error, whenever nothing matches close enough — this
 * is the expected, correct outcome for a record that predates ATC's own
 * imported results or comes from a source broader than this league (this
 * field's own doc comment), not a bug to chase. The Event Briefing page
 * just shows no logo in that case, same graceful-degradation as everywhere
 * else a car_logos lookup can come up empty.
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
 * Builds a fast `(circuitId, eventLayoutName) -> count` lookup for "how many
 * historical rounds match this event's circuit+layout" — what calendar.astro
 * needs for every event's "Race Recaps at this Layout (N)" badge. (The round
 * LIST itself stays a lazy, per-event fetch via /api/layout-rounds.ts; only
 * the count is needed up front for every event on the page.)
 *
 * Calling findRoundsForLayout(...).length once per event, as calendar.astro
 * used to, re-resolves EVERY round's LayoutMatchKey from scratch for EVERY
 * event — O(events * rounds * (circuits + layouts)) total. With a real
 * season's worth of history (248 events × 237 rounds × ~157 circuits+layouts
 * at the time this was found) that's ~9 million redundant comparisons on
 * every calendar page load, for every visitor — enough synchronous CPU work
 * to occasionally trip Cloudflare's per-request CPU limit outright (Free
 * plan; see wrangler.jsonc's note on Error 1102). It also only gets worse as
 * more rounds/events are added, which is why this kept resurfacing without
 * any code changing.
 *
 * This resolves each round's LayoutMatchKey exactly ONCE (O(rounds *
 * (circuits + layouts))), tallies counts by key, and returns a closure that
 * looks up an event's count in O(layouts) + O(1) map lookup — total cost
 * across the whole page is O(rounds * (circuits + layouts) + events *
 * layouts): a few orders of magnitude cheaper, and scaling linearly rather
 * than multiplicatively as more history accumulates.
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
 * Site-wide version of getLayoutClassBestLaps (see that function's own doc
 * comment for the by-class/class-at-time-of-lap reasoning both share) —
 * built for circuits.astro, which shows EVERY layout on one page and so
 * needs a per-layout answer for all of them at once, not just one. Same
 * "resolve every round's LayoutMatchKey exactly ONCE, then O(1) lookup per
 * layout" approach as buildLayoutRoundCounter just above (see its own doc
 * comment for the O(events * rounds) blowup a naive per-layout loop would
 * cause) — this is that same idea extended to bucket by class and track a
 * MIN lap time (not just a count) per bucket, from two whole-table bulk
 * fetches (every curated_race_results/race_score_results row with a lap time, not
 * scoped to any particular subsession_id list) rather than one pair of
 * queries per layout.
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
    // restGetAll — same reasoning as getCuratedRaceResultsForSubsessions;
    // a whole-career call can pass hundreds of subsession_ids at once.
    // subsession_id alone is unique here (one curated_rounds row per
    // round), so it's also a sufficient stable sort for pagination.
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
 * Every curated_rounds subsession_id run at a given track (optionally
 * narrowed to one specific layout name), for getLayoutBestLapSeconds below.
 * Matches on curated_rounds.track_name/layout directly rather than the full
 * resolveLayout/circuit_layouts disambiguation machinery elsewhere in this
 * file (findRoundsForLayout, resolveEventLayoutKey, etc.) — that machinery
 * needs the ENTIRE circuits + circuit_layouts + curated_rounds tables in
 * memory, an acceptable once-per-page-load cost on /calendar but far too
 * expensive to pay on every single page's nav render (see Nav.astro's
 * "Happening Now" banner, the only caller of this). Falls back to matching
 * the track alone if a specific layout name was given but doesn't match any
 * round on file (same "circuit-level fallback" reasoning as
 * resolveEventLayoutKey), then to a case-insensitive match on the track name
 * as a last resort for minor punctuation/casing drift between
 * events.circuits.name and curated_rounds.track_name.
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
 * The fastest lap ever recorded at a track (optionally narrowed to one
 * layout name), in seconds — powers the "Happening Now" nav banner's race
 * duration ESTIMATE (see src/lib/liveEvent.ts): (this + a 5s buffer) × the
 * race's scheduled lap count, used only for whichever race is the LAST
 * scheduled session of a live event, since races are scored by lap count
 * rather than a fixed duration (see EventRecord's own comment) and there's
 * no later session to just count down to instead. Returns null (never
 * throws) on any failure or when no historical lap data exists yet (a
 * brand-new circuit/layout) — the caller falls back to a flat assumed
 * duration in that case.
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
 * Each driver's fastest-ever lap at a track (optionally narrowed to one
 * layout — same track_name/layout matching as findSubsessionIdsForTrack/
 * getLayoutBestLapSeconds just above, not the full circuit_layouts
 * disambiguation machinery), excluding one specific round — powers the
 * round results page's "beat their personal best at this track" detail-
 * panel indicator (per Logan: "like the track record logic in the race
 * recaps," but per-DRIVER rather than the whole-round-vs-official-record
 * comparison newsRecap.ts's matchCircuitLayout()/isTrackRecord do). Scoped
 * to just this one track's rounds and the given drivers (not every driver
 * on file), same bounded-bulk-fetch-once-per-page-load reasoning as
 * getLayoutClassBestLaps, to stay well under Cloudflare Workers' per-request
 * subrequest limit (see this file's own header comment on that class of
 * bug). Returns an empty map (never throws) rather than letting a lookup
 * failure here break the whole results page — callers should still wrap
 * this in their own try/catch the way every other page-level fetch here is,
 * since an empty map degrades gracefully (no PB indicator shown) either way.
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
