/**
 * Manual Race/Qualifying/Practice Results CSV import: raw per-driver rows into curated_rounds and the curated_*
 * results tables, never points (the database scores them from the season's ruleset).
 * - The one importer writing pipeline-owned tables: a Logan-approved exception using negative subsession_ids
 *   (0028). For exhibitions and one-offs only: a round the pipeline also imports would show up twice.
 * - The three share one import_key namespace (manual_result_imports); event_id is matched by circuit + date.
 * - Rows join drivers by `drivers.iracing_cust_id`, so set it on the Roster first or the row is skipped.
 */
import {
  restGet,
  restGetAll,
  restGetAuthed,
  restPost,
  restPatch,
  restDelete,
  type SupabaseEnv,
} from './db/client';
import { getCircuits } from './db/circuits';
import { getSeasons } from './db/seasons';
import { getEvents } from './db/events';
import { getAllDriverSeasonCarNumbers } from './db/drivers';

export interface ImportDriver {
  id: string;
  name: string;
  car_number: number | null;
  iracing_cust_id: number | null;
}

function getDriversForImport(env: SupabaseEnv) {
  return restGet<ImportDriver[]>(env, 'drivers?select=id,name,car_number,iracing_cust_id');
}

/**
 * A CSV car number to a driver for one season, preferring that season's number override (0044) over today's
 * car_number; otherwise a renumbered driver would vanish from that round. Shared with the Incident Report's
 * CSV import.
 */
export function resolveDriverByCarNumberForSeason<D extends { id: string; car_number: number | null }>(
  drivers: D[],
  seasonCarNumbers: Map<string, number>, // `${driverId}:${seasonId}` -> car_number
  seasonId: string,
  carNumber: number,
): D | undefined {
  const overridden = drivers.find((d) => seasonCarNumbers.get(`${d.id}:${seasonId}`) === carNumber);
  if (overridden) return overridden;
  // Today's number applies only to drivers with no override this season, or a renumbered driver would match
  // their old rows too.
  return drivers.find((d) => d.car_number === carNumber && !seasonCarNumbers.has(`${d.id}:${seasonId}`));
}

interface ManualResultImportRow {
  import_key: string;
  subsession_id: number;
}

function getManualResultImports(env: SupabaseEnv, accessToken: string) {
  return restGetAuthed<ManualResultImportRow[]>(
    env,
    accessToken,
    'manual_result_imports?select=import_key,subsession_id',
  );
}

/**
 * Negative so it never collides with a pipeline (positive) subsession_id. Date.now() × 1000 plus a counter
 * stays unique within MAX_SAFE_INTEGER; an id is generated once per new round, so it needn't survive
 * restarts.
 */
let syntheticIdCounter = 0;
function nextSyntheticSubsessionId(): number {
  syntheticIdCounter += 1;
  return -(Date.now() * 1000 + syntheticIdCounter);
}

/** "M:SS.sss" or "SS.sss" -> ten-thousandths of a second, matching curated_race_results.average_lap_ten_thousandths/best_lap_ten_thousandths. Blank/unparseable -> null (both columns are optional). */
export function parseLapTimeToTenThousandths(v: string): number | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 10000);
}

export interface RaceResultsImportOutcome {
  imported: number;
  skipped: number;
}

export type RowGetter = (row: string[], name: string) => string;

/** Bulk, read-only context every importer's resolveRoundIdentity() call needs — fetched once per CSV upload, not once per group. */
export interface RoundLookupContext {
  circuits: { id: string; name: string }[];
  seasons: { id: string; name: string }[];
  events: { id: string; circuit_id: string | null; event_date: string }[];
  importByKey: Map<string, number>;
}

export interface RoundIdentity {
  importKey: string;
  subsessionId: number;
  alreadyImported: boolean;
  seasonId: string;
  seasonName: string;
  circuitName: string;
  layoutName: string;
  eventDate: string;
  startTimeIso: string;
  format: 'endurance' | 'sprint' | null;
  strengthOfField: number | null;
  isExhibition: boolean;
  isTest: boolean;
  eventId: string | null;
}

/**
 * Resolves and validates the round fields from a group's first row, including event_id by circuit + date;
 * null when circuit, season or date don't resolve (skip the group). Read-only, so each importer can clear its
 * own results table before writeRoundRow(). `newSubsessionId` is injectable for tests.
 */
export function resolveRoundIdentity(
  importKey: string,
  get: RowGetter,
  first: string[],
  ctx: RoundLookupContext,
  newSubsessionId: () => number = nextSyntheticSubsessionId,
): RoundIdentity | null {
  const circuitName = get(first, 'circuit_name');
  const layoutName = get(first, 'layout');
  const seasonName = get(first, 'season_name');
  const eventDate = get(first, 'event_date');
  const eventTimeRaw = get(first, 'event_time') || '19:00';
  const eventTime = eventTimeRaw.length === 5 ? `${eventTimeRaw}:00` : eventTimeRaw;
  const formatRaw = get(first, 'format').toLowerCase();
  const format = formatRaw === 'endurance' || formatRaw === 'sprint' ? formatRaw : null;
  const sofRaw = get(first, 'strength_of_field');
  const strengthOfField = sofRaw ? Number(sofRaw) : null;
  const exhibitionRaw = get(first, 'exhibition').toLowerCase();
  const isExhibition = exhibitionRaw === 'yes' || exhibitionRaw === 'true' || exhibitionRaw === '1';
  const testRaw = get(first, 'test').toLowerCase();
  const isTest = testRaw === 'yes' || testRaw === 'true' || testRaw === '1';

  const circuit = ctx.circuits.find((c) => c.name.toLowerCase() === circuitName.toLowerCase());
  const season = ctx.seasons.find((s) => s.name.toLowerCase() === seasonName.toLowerCase());
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate);
  // Unrecognized circuit/season name or malformed date — a `layout` value
  // that doesn't match any circuit_layouts row is tolerated (it just fails
  // to resolve a specific one), so `layoutName` isn't validated here.
  if (!circuit || !season || !validDate) return null;

  const matchingEvents = ctx.events.filter((e) => e.circuit_id === circuit.id && e.event_date === eventDate);
  const eventId = matchingEvents.length === 1 ? matchingEvents[0].id : null;

  const alreadyImported = ctx.importByKey.has(importKey);
  const subsessionId = alreadyImported ? ctx.importByKey.get(importKey)! : newSubsessionId();

  return {
    importKey,
    subsessionId,
    alreadyImported,
    seasonId: season.id,
    seasonName: season.name,
    circuitName: circuit.name,
    layoutName,
    eventDate,
    startTimeIso: `${eventDate}T${eventTime}.000Z`,
    format,
    strengthOfField,
    isExhibition,
    isTest,
    eventId,
  };
}

/**
 * Upserts the curated_rounds row, manual_result_imports link and exhibition/test flags; call after clearing
 * the importer's own results. num_drivers is the race grid size, so only the race importer overwrites it on
 * an existing round; any importer seeds it on a new one.
 */
async function writeRoundRow(
  env: SupabaseEnv,
  accessToken: string,
  identity: RoundIdentity,
  numDrivers: number,
  updateNumDrivers: boolean,
): Promise<void> {
  const roundFields = {
    season_id: identity.seasonId,
    start_time: identity.startTimeIso,
    track_name: identity.circuitName,
    season_label: identity.seasonName,
    layout: identity.layoutName || null,
    format: identity.format,
    strength_of_field: identity.strengthOfField,
    event_id: identity.eventId,
  };

  if (identity.alreadyImported) {
    await restPatch(env, accessToken, `curated_rounds?subsession_id=eq.${identity.subsessionId}`, {
      ...roundFields,
      ...(updateNumDrivers ? { num_drivers: numDrivers } : {}),
    });
  } else {
    await restPost(env, accessToken, 'curated_rounds', {
      subsession_id: identity.subsessionId,
      round_number: null,
      num_drivers: numDrivers,
      ...roundFields,
    });
    await restPost(env, accessToken, 'manual_result_imports', {
      import_key: identity.importKey,
      subsession_id: identity.subsessionId,
    });
  }

  if (identity.isExhibition) {
    try {
      try {
        await restPost(env, accessToken, 'round_overrides', {
          subsession_id: identity.subsessionId,
          is_exhibition: true,
        });
      } catch {
        await restPatch(env, accessToken, `round_overrides?subsession_id=eq.${identity.subsessionId}`, {
          is_exhibition: true,
        });
      }
    } catch (err) {
      console.error(
        `Failed to set the exhibition flag for manual round "${identity.importKey}" (the round itself still imported):`,
        err,
      );
    }
  }

  // The test flag (0036), set like the exhibition flag from the CSV's `test` column, which is prefilled from
  // the linked event's category. The only way to flag a test round: the event is the source of truth (Logan).
  if (identity.isTest) {
    try {
      try {
        await restPost(env, accessToken, 'round_overrides', {
          subsession_id: identity.subsessionId,
          is_test: true,
        });
      } catch {
        await restPatch(env, accessToken, `round_overrides?subsession_id=eq.${identity.subsessionId}`, {
          is_test: true,
        });
      }
    } catch (err) {
      console.error(
        `Failed to set the test flag for manual round "${identity.importKey}" (the round itself still imported):`,
        err,
      );
    }
  }
}

/** Groups CSV data rows (everything after the header) by their `import_key` column, skipping fully-blank rows and counting keyless rows as skipped. Shared by every importer below. */
export function groupRowsByImportKey(
  rows: string[][],
  get: RowGetter,
): { groups: Map<string, string[][]>; skipped: number } {
  const groups = new Map<string, string[][]>();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (row.every((c) => c.trim() === '')) continue;
    const key = get(row, 'import_key');
    if (!key) {
      skipped++;
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return { groups, skipped };
}

/** Trims and lower-cases every header cell, so column lookups are case-insensitive and a leading BOM (which `trim()` removes) never hides the first column. */
export function normaliseHeader(header: string[]): string[] {
  return header.map((h) => h.trim().toLowerCase());
}

export function makeGetter(header: string[]): RowGetter {
  const colIndex = (name: string) => header.indexOf(name);
  return (row: string[], name: string) => {
    const i = colIndex(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };
}

/** The curated_race_results row the race importer posts for one CSV row. */
export interface CuratedRaceResultInsert {
  subsession_id: number;
  race_number: number;
  cust_id: number;
  display_name: string;
  car_name: string | null;
  car_class_name: string | null;
  finish_position: number;
  starting_position: number;
  adjusted_position: null;
  incidents: number;
  laps_complete: number | null;
  laps_led: number;
  interval_ten_thousandths: number | null;
  average_lap_ten_thousandths: number | null;
  best_lap_ten_thousandths: number | null;
}

export type MappedRaceResult =
  | { ok: true; record: CuratedRaceResultInsert }
  | {
      ok: false;
      reason: 'driver' | 'race_number' | 'finish_position' | 'no_cust_id';
      raceNumber: number;
      carNumber: number;
    };

/**
 * Maps one race-results CSV row to the row to insert, or the reason it is skipped. Pure, so the
 * row rules can be tested without a database. When several checks fail, the first of `driver`,
 * `race_number`, `finish_position`, `no_cust_id` is reported.
 */
export function mapRaceResultRow(
  row: string[],
  get: RowGetter,
  subsessionId: number,
  resolveDriver: (carNumber: number) => ImportDriver | undefined,
): MappedRaceResult {
  const carNumberRaw = get(row, 'driver_car_number');
  const carNumber = carNumberRaw ? Number(carNumberRaw) : NaN;
  const driver = Number.isFinite(carNumber) ? resolveDriver(carNumber) : undefined;
  const raceNumberRaw = get(row, 'race_number');
  const raceNumber = raceNumberRaw ? Number(raceNumberRaw) : NaN;
  const finishPositionRaw = get(row, 'finish_position');
  const finishPosition = finishPositionRaw ? Number(finishPositionRaw) : NaN;

  if (!driver) return { ok: false, reason: 'driver', raceNumber, carNumber };
  if (!Number.isFinite(raceNumber)) return { ok: false, reason: 'race_number', raceNumber, carNumber };
  if (!Number.isFinite(finishPosition))
    return { ok: false, reason: 'finish_position', raceNumber, carNumber };
  if (driver.iracing_cust_id == null) return { ok: false, reason: 'no_cust_id', raceNumber, carNumber };

  const startingPositionRaw = get(row, 'starting_position');
  const incidentsRaw = get(row, 'incidents');
  const lapsCompleteRaw = get(row, 'laps_complete');
  const lapsLedRaw = get(row, 'laps_led');
  const intervalRaw = get(row, 'interval_ten_thousandths');
  const classNameRaw = get(row, 'class_name');

  return {
    ok: true,
    record: {
      subsession_id: subsessionId,
      race_number: raceNumber,
      cust_id: driver.iracing_cust_id,
      // display_name is NOT NULL; it comes from the roster, the name every other page shows.
      display_name: driver.name,
      car_name: get(row, 'car_name') || null,
      car_class_name: classNameRaw || null,
      finish_position: finishPosition,
      starting_position: startingPositionRaw ? Number(startingPositionRaw) : finishPosition,
      adjusted_position: null,
      incidents: incidentsRaw ? Number(incidentsRaw) : 0,
      laps_complete: lapsCompleteRaw ? Number(lapsCompleteRaw) : null,
      laps_led: lapsLedRaw ? Number(lapsLedRaw) : 0,
      interval_ten_thousandths: intervalRaw ? Number(intervalRaw) : null,
      average_lap_ten_thousandths: parseLapTimeToTenThousandths(get(row, 'average_lap_time')),
      best_lap_ten_thousandths: parseLapTimeToTenThousandths(get(row, 'best_lap_time')),
    },
  };
}

/**
 * Rows sharing an `import_key` are one round with one synthetic subsession_id. Re-uploading a key replaces
 * that round's race results entirely, so a corrected file fully takes over.
 */
export async function importRaceResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][],
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = normaliseHeader(rows[0] ?? []);
  const get = makeGetter(header);

  const [circuits, seasons, events, drivers, existingImports, seasonCarNumberRows] = await Promise.all([
    getCircuits(env),
    getSeasons(env),
    getEvents(env),
    getDriversForImport(env),
    getManualResultImports(env, accessToken),
    getAllDriverSeasonCarNumbers(env),
  ]);
  const ctx: RoundLookupContext = {
    circuits,
    seasons,
    events,
    importByKey: new Map(existingImports.map((r) => [r.import_key, r.subsession_id])),
  };
  const seasonCarNumbers = new Map(
    seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]),
  );

  const { groups, skipped: keylessSkipped } = groupRowsByImportKey(rows, get);
  skipped += keylessSkipped;

  for (const [importKey, groupRows] of groups) {
    const first = groupRows[0];
    const identity = resolveRoundIdentity(importKey, get, first, ctx);
    if (!identity) {
      skipped += groupRows.length;
      continue;
    }

    if (identity.alreadyImported) {
      try {
        await restDelete(env, accessToken, `curated_race_results?subsession_id=eq.${identity.subsessionId}`);
      } catch (err) {
        console.error(`Failed to clear previous rows for manual round "${importKey}" before re-import:`, err);
        skipped += groupRows.length;
        continue;
      }
    }

    const driverCarNumbers = new Set(groupRows.map((r) => get(r, 'driver_car_number')).filter(Boolean));

    try {
      await writeRoundRow(env, accessToken, identity, driverCarNumbers.size, true);
    } catch (err) {
      console.error(`Failed to write curated_rounds for manual round "${importKey}":`, err);
      skipped += groupRows.length;
      continue;
    }

    const resolveDriver = (carNumber: number) =>
      resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, identity.seasonId, carNumber);

    for (const row of groupRows) {
      const mapped = mapRaceResultRow(row, get, identity.subsessionId, resolveDriver);

      if (!mapped.ok) {
        if (mapped.reason === 'no_cust_id') {
          console.error(
            `Skipped a manual result row (round "${importKey}", race ${mapped.raceNumber}, car #${mapped.carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`,
          );
        }
        skipped++;
        continue;
      }

      try {
        await restPost(env, accessToken, 'curated_race_results', mapped.record);
        imported++;
      } catch (err) {
        console.error(
          `Failed to import a race-result row (round "${importKey}", race ${mapped.record.race_number}, car #${Number(get(row, 'driver_car_number'))}):`,
          err,
        );
        skipped++;
      }
    }
  }

  return { imported, skipped };
}

/**
 * Same scheme as importRaceResultsCsv, writing curated_qualifying (position and best lap); a re-upload
 * replaces only that round's qualifying rows.
 */
export async function importQualifyingResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][],
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = normaliseHeader(rows[0] ?? []);
  const get = makeGetter(header);

  const [circuits, seasons, events, drivers, existingImports, seasonCarNumberRows] = await Promise.all([
    getCircuits(env),
    getSeasons(env),
    getEvents(env),
    getDriversForImport(env),
    getManualResultImports(env, accessToken),
    getAllDriverSeasonCarNumbers(env),
  ]);
  const ctx: RoundLookupContext = {
    circuits,
    seasons,
    events,
    importByKey: new Map(existingImports.map((r) => [r.import_key, r.subsession_id])),
  };
  const seasonCarNumbers = new Map(
    seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]),
  );

  const { groups, skipped: keylessSkipped } = groupRowsByImportKey(rows, get);
  skipped += keylessSkipped;

  for (const [importKey, groupRows] of groups) {
    const first = groupRows[0];
    const identity = resolveRoundIdentity(importKey, get, first, ctx);
    if (!identity) {
      skipped += groupRows.length;
      continue;
    }

    if (identity.alreadyImported) {
      try {
        await restDelete(env, accessToken, `curated_qualifying?subsession_id=eq.${identity.subsessionId}`);
      } catch (err) {
        console.error(
          `Failed to clear previous qualifying rows for manual round "${importKey}" before re-import:`,
          err,
        );
        skipped += groupRows.length;
        continue;
      }
    }

    const driverCarNumbers = new Set(groupRows.map((r) => get(r, 'driver_car_number')).filter(Boolean));

    try {
      // Never overwrite num_drivers from a qualifying upload — that field
      // reflects the race's grid size, which only the race importer owns.
      await writeRoundRow(env, accessToken, identity, driverCarNumbers.size, false);
    } catch (err) {
      console.error(`Failed to write curated_rounds for manual round "${importKey}":`, err);
      skipped += groupRows.length;
      continue;
    }

    for (const row of groupRows) {
      const carNumberRaw = get(row, 'driver_car_number');
      const carNumber = carNumberRaw ? Number(carNumberRaw) : NaN;
      const driver = Number.isFinite(carNumber)
        ? resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, identity.seasonId, carNumber)
        : undefined;
      const qualPositionRaw = get(row, 'qual_position');
      const qualPosition = qualPositionRaw ? Number(qualPositionRaw) : NaN;

      if (!driver || !Number.isFinite(qualPosition)) {
        skipped++;
        continue;
      }
      if (driver.iracing_cust_id == null) {
        console.error(
          `Skipped a manual qualifying row (round "${importKey}", car #${carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`,
        );
        skipped++;
        continue;
      }

      try {
        await restPost(env, accessToken, 'curated_qualifying', {
          subsession_id: identity.subsessionId,
          cust_id: driver.iracing_cust_id,
          display_name: driver.name,
          car_class_name: get(row, 'class_name') || null,
          qual_position: qualPosition,
          best_lap_ten_thousandths: parseLapTimeToTenThousandths(get(row, 'best_lap_time')),
        });
        imported++;
      } catch (err) {
        console.error(`Failed to import a qualifying row (round "${importKey}", car #${carNumber}):`, err);
        skipped++;
      }
    }
  }

  return { imported, skipped };
}

/**
 * Same scheme again, writing curated_practice_results (0078): laps and best lap, as practice has no position.
 */
export async function importPracticeResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][],
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = normaliseHeader(rows[0] ?? []);
  const get = makeGetter(header);

  const [circuits, seasons, events, drivers, existingImports, seasonCarNumberRows] = await Promise.all([
    getCircuits(env),
    getSeasons(env),
    getEvents(env),
    getDriversForImport(env),
    getManualResultImports(env, accessToken),
    getAllDriverSeasonCarNumbers(env),
  ]);
  const ctx: RoundLookupContext = {
    circuits,
    seasons,
    events,
    importByKey: new Map(existingImports.map((r) => [r.import_key, r.subsession_id])),
  };
  const seasonCarNumbers = new Map(
    seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]),
  );

  const { groups, skipped: keylessSkipped } = groupRowsByImportKey(rows, get);
  skipped += keylessSkipped;

  for (const [importKey, groupRows] of groups) {
    const first = groupRows[0];
    const identity = resolveRoundIdentity(importKey, get, first, ctx);
    if (!identity) {
      skipped += groupRows.length;
      continue;
    }

    if (identity.alreadyImported) {
      try {
        await restDelete(
          env,
          accessToken,
          `curated_practice_results?subsession_id=eq.${identity.subsessionId}`,
        );
      } catch (err) {
        console.error(
          `Failed to clear previous practice rows for manual round "${importKey}" before re-import:`,
          err,
        );
        skipped += groupRows.length;
        continue;
      }
    }

    const driverCarNumbers = new Set(groupRows.map((r) => get(r, 'driver_car_number')).filter(Boolean));

    try {
      // Same reasoning as the qualifying importer — num_drivers stays owned
      // by the race importer.
      await writeRoundRow(env, accessToken, identity, driverCarNumbers.size, false);
    } catch (err) {
      console.error(`Failed to write curated_rounds for manual round "${importKey}":`, err);
      skipped += groupRows.length;
      continue;
    }

    for (const row of groupRows) {
      const carNumberRaw = get(row, 'driver_car_number');
      const carNumber = carNumberRaw ? Number(carNumberRaw) : NaN;
      const driver = Number.isFinite(carNumber)
        ? resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, identity.seasonId, carNumber)
        : undefined;

      if (!driver) {
        skipped++;
        continue;
      }
      if (driver.iracing_cust_id == null) {
        console.error(
          `Skipped a manual practice row (round "${importKey}", car #${carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`,
        );
        skipped++;
        continue;
      }

      const lapsRaw = get(row, 'laps');

      try {
        await restPost(env, accessToken, 'curated_practice_results', {
          subsession_id: identity.subsessionId,
          cust_id: driver.iracing_cust_id,
          display_name: driver.name,
          car_class_name: get(row, 'class_name') || null,
          laps: lapsRaw ? Number(lapsRaw) : null,
          best_lap_ten_thousandths: parseLapTimeToTenThousandths(get(row, 'best_lap_time')),
        });
        imported++;
      } catch (err) {
        console.error(`Failed to import a practice row (round "${importKey}", car #${carNumber}):`, err);
        skipped++;
      }
    }
  }

  return { imported, skipped };
}

// --- Read side: the Admin > Add Race Result checklist of finished events still missing results. ---

export interface EventResultCoverage {
  eventId: string;
  circuitName: string;
  layout: string | null;
  seasonName: string | null;
  eventDate: string;
  category: string;
  format: string | null;
  /** 'HH:MM:SS' or null — this event's own scheduled session times, carried through so a template download (src/pages/api/import-templates/[kind].ts) can prefill the right one for whichever kind was requested, without a second event fetch. */
  raceStartTime: string | null;
  qualifyingStartTime: string | null;
  practiceStartTime: string | null;
  missingRace: boolean;
  missingQualifying: boolean;
  missingPractice: boolean;
  /**
   * The import_key of the manual round already linked to this event, so another session type attaches to it.
   * Null with no round, or when the round came from the pipeline (out of scope for this importer).
   */
  importKey: string | null;
}

/**
 * Holiday/iRacing events have no sessions, so only these categories can have results; explicit rather than
 * relying on their missing start times.
 */
const EVENTS_ELIGIBLE_FOR_RESULTS = new Set(['championship', 'test', 'exhibition']);

/** Every distinct subsession_id present in one results table, restricted to a known set of subsession_ids (so this stays a cheap, bounded query no matter how much history the table holds). restGetAll (not restGet) since a table like curated_race_results has many rows per round — one per driver per race — and could exceed Supabase's default 1000-row response cap well before the round count itself does. */
async function distinctSubsessionIds(
  env: SupabaseEnv,
  table: string,
  subsessionIds: number[],
): Promise<Set<number>> {
  if (subsessionIds.length === 0) return new Set();
  const rows = await restGetAll<{ subsession_id: number }>(
    env,
    `${table}?select=subsession_id&subsession_id=in.(${subsessionIds.join(',')})`,
  );
  return new Set(rows.map((r) => r.subsession_id));
}

/**
 * Finished events missing a session result they were scheduled to have (one with a start time), so a raceless
 * test session isn't flagged. Unlike get_missing_race_results_count() (0078), which still backs the dashboard
 * count, this returns rows and needs the admin-only manual_result_imports.
 */
export async function getEventsMissingResults(
  env: SupabaseEnv,
  accessToken: string,
): Promise<EventResultCoverage[]> {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [events, rounds, existingImports] = await Promise.all([
    getEvents(env),
    restGetAll<{ subsession_id: number; event_id: string | null }>(
      env,
      'curated_rounds?select=subsession_id,event_id&event_id=not.is.null',
    ),
    getManualResultImports(env, accessToken),
  ]);

  const finished = events.filter(
    (e) => EVENTS_ELIGIBLE_FOR_RESULTS.has(e.category) && e.event_date < todayStr,
  );
  if (finished.length === 0) return [];

  const finishedEventIds = new Set(finished.map((e) => e.id));
  const relevantRounds = rounds.filter((r) => r.event_id && finishedEventIds.has(r.event_id));
  const relevantSubsessionIds = relevantRounds.map((r) => r.subsession_id);

  const [raceSubsessions, qualifyingSubsessions, practiceSubsessions] = await Promise.all([
    distinctSubsessionIds(env, 'curated_race_results', relevantSubsessionIds),
    distinctSubsessionIds(env, 'curated_qualifying', relevantSubsessionIds),
    distinctSubsessionIds(env, 'curated_practice_results', relevantSubsessionIds),
  ]);

  const roundByEventId = new Map(relevantRounds.map((r) => [r.event_id as string, r]));
  const importKeyBySubsession = new Map(existingImports.map((r) => [r.subsession_id, r.import_key]));

  const out: EventResultCoverage[] = [];
  for (const e of finished) {
    const round = roundByEventId.get(e.id);
    // Race 1 always happens for championship and exhibition events (0003); a null race1_start_time there is
    // usually a 0072 backfilled event. Only test sessions can have no race (0054).
    const raceExpected = e.category === 'test' ? Boolean(e.race1_start_time) : true;
    const missingRace = raceExpected && (!round || !raceSubsessions.has(round.subsession_id));
    const missingQualifying =
      Boolean(e.qualifying_start_time) && (!round || !qualifyingSubsessions.has(round.subsession_id));
    const missingPractice =
      Boolean(e.practice_start_time) && (!round || !practiceSubsessions.has(round.subsession_id));
    if (!missingRace && !missingQualifying && !missingPractice) continue;

    out.push({
      eventId: e.id,
      circuitName: e.circuits?.name ?? e.title ?? 'Unknown',
      layout: e.layout,
      seasonName: e.seasons?.name ?? null,
      eventDate: e.event_date,
      category: e.category,
      format: e.format,
      raceStartTime: e.race1_start_time,
      qualifyingStartTime: e.qualifying_start_time,
      practiceStartTime: e.practice_start_time,
      missingRace,
      missingQualifying,
      missingPractice,
      importKey: round ? (importKeyBySubsession.get(round.subsession_id) ?? null) : null,
    });
  }

  // Most-recently-finished first — the freshest gaps are the ones an admin
  // is most likely checking in for.
  out.sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  return out;
}

/** Slugifies text into the lowercase-no-punctuation style the existing manual import_key examples already use (e.g. "exh-2026-08-09-watkinsglen") — see RACE_RESULTS_TEMPLATE in importTemplates.ts. */
export function slugifyForImportKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * A starting import_key for an event with no manual round, only to prefill a downloaded template; once a
 * round exists its own key is reused.
 */
export function suggestImportKey(
  ev: Pick<EventResultCoverage, 'category' | 'eventDate' | 'circuitName'>,
): string {
  const prefix = ev.category === 'exhibition' ? 'exh' : ev.category === 'test' ? 'test' : 'evt';
  return `${prefix}-${ev.eventDate}-${slugifyForImportKey(ev.circuitName)}`;
}
