/**
 * Track records computed from the league's own laps (functional spec W1, W2, W4; BR1.1-BR1.9). Every page that
 * shows a record builds it here from the same view (round_best_laps_shown), so a layout shows the same record
 * everywhere (BR1.7). Everything but loadLeagueRecords is pure.
 */
import type { SupabaseEnv } from '../db/client';
import {
  formatLapTime,
  getAllCircuitLayouts,
  getCircuits,
  type Circuit,
  type CircuitLayout,
} from '../db/circuits';
import { getRoundBestLaps, type RoundBestLap } from '../db/roundBestLaps';
import type { CarLogo } from '../db/assets';
import { LEAGUE_TIME_ZONE } from '../timezone';
import { driversSelect, type DriverBasic } from './rows';
import type { ClassBestLap } from './layoutLaps';
import { normalizeTrackOrLayoutName, type LayoutMatchKey } from './layouts';

/** `layout:<id>` or `circuit:<id>`, the string form of a LayoutKey. */
export type RecordKey = string;

/** Overall, or one class id. */
export type RecordFilter = 'overall' | number;

export function recordKeyOf(key: LayoutMatchKey): RecordKey {
  return `${key.kind}:${key.id}`;
}

/**
 * The LayoutKey a round's laps count toward (BR1.2): the circuit when it has no layout rows, its only layout,
 * or the one layout whose name matches the round's recorded layout. Anything else counts toward nothing, so
 * unlike resolveRoundLayoutKey there is no circuit fallback on a multi-layout circuit.
 */
export function resolveRecordLayoutKey(
  trackName: string,
  layoutText: string | null,
  circuits: readonly Circuit[],
  layouts: readonly CircuitLayout[],
): LayoutMatchKey | null {
  return createRecordKeyResolver(circuits, layouts).resolveKey(trackName, layoutText);
}

export interface RecordKeyResolver {
  resolveKey(trackName: string, layoutText: string | null): LayoutMatchKey | null;
  /** The same key as a RecordKey string, memoised per (track, layout) pair (W1 step 2). */
  resolve(trackName: string, layoutText: string | null): RecordKey | null;
}

/** A resolver with the circuits and layouts indexed once, so a page resolves each distinct pair once. */
export function createRecordKeyResolver(
  circuits: readonly Circuit[],
  layouts: readonly CircuitLayout[],
): RecordKeyResolver {
  const circuitByName = new Map<string, Circuit>();
  for (const c of circuits) {
    const name = normalizeTrackOrLayoutName(c.name);
    if (!circuitByName.has(name)) circuitByName.set(name, c);
  }
  const layoutsByCircuit = new Map<string, CircuitLayout[]>();
  for (const l of layouts) {
    if (!layoutsByCircuit.has(l.circuit_id)) layoutsByCircuit.set(l.circuit_id, []);
    layoutsByCircuit.get(l.circuit_id)!.push(l);
  }
  const memo = new Map<string, RecordKey | null>();

  function resolveKey(trackName: string, layoutText: string | null): LayoutMatchKey | null {
    const circuit = circuitByName.get(normalizeTrackOrLayoutName(trackName));
    if (!circuit) return null;
    const own = layoutsByCircuit.get(circuit.id) ?? [];
    if (own.length === 0) return { kind: 'circuit', id: circuit.id };
    if (own.length === 1) return { kind: 'layout', id: own[0].id };
    if (!layoutText) return null;
    const target = normalizeTrackOrLayoutName(layoutText);
    const match = own.find((l) => normalizeTrackOrLayoutName(l.name) === target);
    return match ? { kind: 'layout', id: match.id } : null;
  }

  return {
    resolveKey,
    resolve(trackName, layoutText) {
      const memoKey = `${trackName}\u0000${layoutText ?? ''}`;
      if (!memo.has(memoKey)) {
        const key = resolveKey(trackName, layoutText);
        memo.set(memoKey, key ? recordKeyOf(key) : null);
      }
      return memo.get(memoKey)!;
    },
  };
}

/** Ten-thousandths of a second to whole milliseconds, the precision records are compared at (BR1.4). */
export function lapMs(tenThousandths: number): number {
  return Math.round(tenThousandths / 10);
}

function secondsMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Negative when lap `a` ranks ahead of `b` (BR1.3): the faster lap, then the earlier start, the lower
 * subsession, the lower race number and the lower finish. The masked cust_id is never used, so every viewer
 * sees the same holder.
 */
export function compareRecordLaps(a: RoundBestLap, b: RoundBestLap): number {
  return (
    a.best_lap_ten_thousandths - b.best_lap_ten_thousandths ||
    new Date(a.start_time).getTime() - new Date(b.start_time).getTime() ||
    a.subsession_id - b.subsession_id ||
    a.race_number - b.race_number ||
    a.finish_position - b.finish_position
  );
}

/** The winning lap per (key, filter): `${key}|overall` and `${key}|${classId}`. */
export type LeagueRecords = Map<string, RoundBestLap>;

function slot(key: RecordKey, filter: RecordFilter): string {
  return `${key}|${filter}`;
}

/**
 * The league records from the view's rows (W1 steps 2-4). Rows that resolve to no key, or that carry no lap,
 * count toward nothing; a row with no class counts toward Overall only (BR1.1, BR1.9).
 */
export function buildLeagueRecords(
  rows: readonly RoundBestLap[],
  resolve: (trackName: string, layoutText: string | null) => RecordKey | null,
): LeagueRecords {
  const out: LeagueRecords = new Map();
  const offer = (s: string, row: RoundBestLap) => {
    const current = out.get(s);
    if (!current || compareRecordLaps(row, current) < 0) out.set(s, row);
  };
  for (const row of rows) {
    if (!(row.best_lap_ten_thousandths > 0)) continue;
    const key = resolve(row.track_name, row.layout);
    if (!key) continue;
    offer(slot(key, 'overall'), row);
    if (row.class_id !== null) offer(slot(key, row.class_id), row);
  }
  return out;
}

export function leagueRecord(
  records: LeagueRecords,
  key: RecordKey | null,
  filter: RecordFilter,
): RoundBestLap | null {
  return key ? (records.get(slot(key, filter)) ?? null) : null;
}

const leagueDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: LEAGUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A start time's date in the league's time zone, as 'YYYY-MM-DD'. */
export function leagueDate(startTime: string): string {
  return leagueDateFormat.format(new Date(startTime));
}

/** The record a page shows for one key and filter (TrackRecord entity). */
export interface TrackRecord {
  seconds: number;
  formatted: string;
  holderName: string | null;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  source: 'typed' | 'league';
  carName: string | null;
  /** The roster driver behind a league record, for a profile link; null for a typed record. */
  driverId: string | null;
}

/** The typed record fields of a layout (Admin > Circuits). */
export type TypedRecord = Pick<CircuitLayout, 'lap_record_seconds' | 'lap_record_holder' | 'lap_record_date'>;

/**
 * A league lap as a record (BR1.5): the roster driver's shown name, else the result's shown name; "Hidden
 * Driver" for a hidden driver, whose date still shows.
 */
export function leagueTrackRecord(
  row: RoundBestLap,
  driverNameById: ReadonlyMap<string, string> = new Map(),
): TrackRecord {
  const seconds = lapMs(row.best_lap_ten_thousandths) / 1000;
  return {
    seconds,
    formatted: formatLapTime(seconds),
    holderName:
      (row.roster_driver_id ? driverNameById.get(row.roster_driver_id) : undefined) ?? row.display_name,
    date: leagueDate(row.start_time),
    source: 'league',
    carName: row.car_name,
    driverId: row.roster_driver_id,
  };
}

function typedTrackRecord(typed: TypedRecord): TrackRecord {
  const seconds = typed.lap_record_seconds as number;
  return {
    seconds,
    formatted: formatLapTime(seconds),
    holderName: typed.lap_record_holder,
    date: typed.lap_record_date,
    source: 'typed',
    carName: null,
    driverId: null,
  };
}

/**
 * The Overall record (BR1.4, BR1.5): the faster of the typed record and the league lap, compared to the
 * millisecond, with the typed record winning a tie. Null when neither exists.
 */
export function combineOverallRecord(
  typed: TypedRecord | null,
  league: RoundBestLap | null,
  driverNameById?: ReadonlyMap<string, string>,
): TrackRecord | null {
  const hasTyped = typed !== null && typed.lap_record_seconds !== null;
  if (!hasTyped && !league) return null;
  if (!league) return typedTrackRecord(typed!);
  if (!hasTyped) return leagueTrackRecord(league, driverNameById);
  return lapMs(league.best_lap_ten_thousandths) < secondsMs(typed!.lap_record_seconds as number)
    ? leagueTrackRecord(league, driverNameById)
    : typedTrackRecord(typed!);
}

/** A class record: league laps only (BR1.6). */
export function classTrackRecord(
  league: RoundBestLap | null,
  driverNameById?: ReadonlyMap<string, string>,
): TrackRecord | null {
  return league ? leagueTrackRecord(league, driverNameById) : null;
}

/** Roster driver id -> shown name, for record holders. */
export function driverNamesById(drivers: readonly Pick<DriverBasic, 'id' | 'name'>[]): Map<string, string> {
  return new Map(drivers.map((d) => [d.id, d.name]));
}

/**
 * The class bests for one key in the shape the Event Briefing and layout detail already render. A class
 * record always has a roster driver (a scored class needs one); a row whose driver is missing is skipped.
 */
export function classBestLapsFor(
  records: LeagueRecords,
  key: RecordKey | null,
  classIds: readonly number[],
  drivers: readonly DriverBasic[],
  carLogos: readonly CarLogo[],
): Map<number, ClassBestLap> {
  const out = new Map<number, ClassBestLap>();
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const logoByCar = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  for (const classId of classIds) {
    const row = leagueRecord(records, key, classId);
    const driver = row?.roster_driver_id ? driverById.get(row.roster_driver_id) : undefined;
    if (!row || !driver) continue;
    out.set(classId, {
      classId,
      seconds: lapMs(row.best_lap_ten_thousandths) / 1000,
      driver,
      subsessionId: row.subsession_id,
      date: leagueDate(row.start_time),
      carName: row.car_name,
      carLogoUrl: row.car_name ? (logoByCar.get(row.car_name) ?? null) : null,
    });
  }
  return out;
}

export interface LoadedLeagueRecords {
  league: LeagueRecords;
  resolver: RecordKeyResolver;
  circuits: Circuit[];
  layouts: CircuitLayout[];
  drivers: DriverBasic[];
  driverNameById: Map<string, string>;
}

/**
 * W1 for a page: the view plus the circuits, layouts and drivers it is resolved and named with. Only the view
 * is a new request; the rest are memoised reads most record pages already make (NFR2). A failed view read
 * gives no league records (logged inside getRoundBestLaps), so the page falls back to typed records.
 */
export async function loadLeagueRecords(env: SupabaseEnv): Promise<LoadedLeagueRecords> {
  const [rows, circuits, layouts, drivers] = await Promise.all([
    getRoundBestLaps(env),
    getCircuits(env),
    getAllCircuitLayouts(env),
    driversSelect(env, { includeAi: true }),
  ]);
  const resolver = createRecordKeyResolver(circuits, layouts);
  return {
    league: buildLeagueRecords(rows, resolver.resolve),
    resolver,
    circuits,
    layouts,
    drivers,
    driverNameById: driverNamesById(drivers),
  };
}

/**
 * True when round `a` comes before round `b` for the recap (BR1.8): an earlier league-time-zone date, then on
 * the same date an earlier start, then a lower subsession id.
 */
export function isEarlierRound(
  a: Pick<RoundBestLap, 'start_time' | 'subsession_id'>,
  b: Pick<RoundBestLap, 'start_time' | 'subsession_id'>,
): boolean {
  const dateA = leagueDate(a.start_time);
  const dateB = leagueDate(b.start_time);
  if (dateA !== dateB) return dateA < dateB;
  const timeDiff = new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
  if (timeDiff !== 0) return timeDiff < 0;
  return a.subsession_id < b.subsession_id;
}

export interface NewTrackRecordResult {
  isRecord: boolean;
  /** The record it beat, in seconds; null for the first lap at the layout or no marker. */
  previousSeconds: number | null;
}

/**
 * The recap's "new track record" marker for one race's fastest lap (BR1.8). `roundRows` are the view's rows
 * for this round (none means exhibition or test, so no marker); `priorRows` are rows of earlier rounds at the
 * same key. With no prior record the lap is a new record with no previous time; otherwise it must be strictly
 * faster to the millisecond.
 */
export function isNewTrackRecord(input: {
  raceBestTenThousandths: number;
  roundRows: readonly RoundBestLap[];
  priorRows: readonly RoundBestLap[];
  typed: TypedRecord | null;
}): NewTrackRecordResult {
  if (input.roundRows.length === 0) return { isRecord: false, previousSeconds: null };
  const priorLeague = input.priorRows
    .filter((r) => r.best_lap_ten_thousandths > 0)
    .reduce<RoundBestLap | null>((best, r) => (!best || compareRecordLaps(r, best) < 0 ? r : best), null);
  const prior = combineOverallRecord(input.typed, priorLeague);
  if (!prior) return { isRecord: true, previousSeconds: null };
  const isRecord = lapMs(input.raceBestTenThousandths) < secondsMs(prior.seconds);
  return { isRecord, previousSeconds: isRecord ? prior.seconds : null };
}
