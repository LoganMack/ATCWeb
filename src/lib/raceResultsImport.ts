/**
 * Manual Race/Qualifying/Practice Results CSV import — writes RAW PER-DRIVER
 * DATA only, into curated_rounds (the round itself) plus one of
 * curated_race_results / curated_qualifying / curated_practice_results (each
 * driver's finish position or lap time — the same shape the real
 * iRacing-results pipeline populates). It deliberately does NOT write to
 * race_scores: that table holds computed POINTS, produced by the database's
 * own recalculate_race_scores() from a season's scoring ruleset (see Admin >
 * Rulesets) — this importer's job ends at getting the raw results into the
 * database, not at scoring them. A round imported here shows up on Race
 * Results immediately; it will show up in Standings/Career Stats/News
 * Recaps once its season has a scoring ruleset assigned and an admin
 * recalculates that round's scores (that recalculation isn't part of this
 * importer — see the note on Admin > Add Race Result for how the two
 * connect).
 *
 * (Earlier versions of this importer also wrote directly into race_scores,
 * requiring the admin to hand-supply every scoring field — finish_points,
 * class_points, etc. That was a mismatch: those are the scoring engine's
 * output, not raw data, and writing them here made manually-imported rows
 * indistinguishable from real computed ones. Raw-only is the correct scope.)
 *
 * This is still the one importer that writes directly into pipeline-owned
 * tables — see results.ts's own header comment, and 0004_champions.sql/
 * 0014_penalties.sql/0018_curated_rounds_layout.sql for the rule this
 * deliberately breaks. This is a one-off, Logan-approved exception — see
 * 0028_manual_results_import.sql's header for the reasoning and the
 * negative-subsession_id collision-safety scheme that makes it safe.
 *
 * Meant for exhibition races or one-off events the real pipeline will never
 * see. If a round WILL eventually show up in a real pipeline import, don't
 * use this — a synthetic round and a real one for the same event would show
 * up as two separate rounds in every list on the site (the app has no way
 * to know they're "the same" race).
 *
 * All three importers (race/qualifying/practice) share ONE import_key
 * namespace via manual_result_imports — uploading a race CSV and a
 * qualifying CSV under the same import_key ties both to the same
 * curated_rounds row, rather than each creating its own round. See
 * resolveRoundIdentity()/writeRoundRow() below, which every importer calls.
 *
 * Every importer also resolves and stores curated_rounds.event_id
 * (0078_curated_rounds_event_id_and_practice_results.sql) by matching
 * circuit_id + event_date against the events table — the same identity
 * 0079_curated_rounds_event_id_backfill_by_date.sql used to backfill
 * existing history — so a manually-imported round is linked to its event
 * immediately, the same as a real pipeline import going forward. Left null
 * (never guessed) when zero or more than one event matches that circuit+date.
 *
 * ONE IMPORTANT LIMITATION, surfaced to the admin via skipped-row counts
 * rather than failing the whole upload: curated_race_results/curated_
 * qualifying/curated_practice_results all identify a driver by `cust_id`
 * (their iRacing customer id), never by this app's own driver_id — and every
 * reader in results.ts (see getRoundResults/getSeasonOverallContext) joins a
 * row to a driver via `drivers.iracing_cust_id`, not a real foreign key. A
 * driver with no iracing_cust_id set on their Roster profile literally
 * cannot be joined this way — any CSV row for such a driver is skipped. Set
 * the driver's iRacing Customer ID first (Admin > Roster) before importing
 * their results.
 */
import {
  restGet,
  restGetAuthed,
  restPost,
  restPatch,
  restDelete,
  getCircuits,
  getSeasons,
  getEvents,
  getAllDriverSeasonCarNumbers,
  type SupabaseEnv,
} from './supabase';

interface ImportDriver {
  id: string;
  name: string;
  car_number: number | null;
  iracing_cust_id: number | null;
}

function getDriversForImport(env: SupabaseEnv) {
  return restGet<ImportDriver[]>(env, 'drivers?select=id,name,car_number,iracing_cust_id');
}

/**
 * Resolves a CSV row's `driver_car_number` to a driver for one specific
 * season — preferring that driver's driver_season_car_numbers override for
 * THIS season (see 0044_driver_season_car_numbers.sql) over their current
 * drivers.car_number. Without this, a driver whose number has since changed
 * (or been cleared) would silently fail to match here, meaning their row for
 * that past round never gets created at all — they'd be entirely missing
 * from that round's results, with everyone behind them compressing upward
 * in the class-relative ranking (looks exactly like a phantom penalty), and
 * unselectable in that round's Incident Report (which reads its driver list
 * straight from the round's results).
 *
 * Exported (rather than kept local to this file's own importer) since the
 * Incident Report's own CSV bulk-importer (src/pages/results/[subsessionId]/
 * incidents.astro) resolves car numbers to drivers the exact same way, for
 * the exact same reason.
 */
export function resolveDriverByCarNumberForSeason<D extends { id: string; car_number: number | null }>(
  drivers: D[],
  seasonCarNumbers: Map<string, number>, // `${driverId}:${seasonId}` -> car_number
  seasonId: string,
  carNumber: number
): D | undefined {
  const overridden = drivers.find((d) => seasonCarNumbers.get(`${d.id}:${seasonId}`) === carNumber);
  if (overridden) return overridden;
  // Only fall back to a driver's CURRENT number if they don't have an
  // explicit override for this season at all — otherwise a driver whose
  // number changed would still incorrectly match their old CSV rows via
  // their now-stale current number, alongside whoever the number was
  // reassigned to for that season.
  return drivers.find((d) => d.car_number === carNumber && !seasonCarNumbers.has(`${d.id}:${seasonId}`));
}

interface ManualResultImportRow {
  import_key: string;
  subsession_id: number;
}

function getManualResultImports(env: SupabaseEnv, accessToken: string) {
  return restGetAuthed<ManualResultImportRow[]>(env, accessToken, 'manual_result_imports?select=import_key,subsession_id');
}

/**
 * Negative, so a real pipeline import (always a positive subsession_id) can
 * never collide with a manually-imported round. `Date.now()` (ms) shifted
 * up three decimal digits plus a per-call counter keeps every round
 * generated across the lifetime of this server instance unique — safely
 * inside Number.MAX_SAFE_INTEGER (~9e15 vs. Date.now()'s ~1.8e12 * 1000).
 * This is a low-frequency admin-only operation (one CSV upload at a time),
 * so this simple in-memory scheme is enough; it doesn't need to survive a
 * server restart mid-request the way a database sequence would, since a
 * fresh id is only ever generated once per NEW round, never re-derived.
 */
let syntheticIdCounter = 0;
function nextSyntheticSubsessionId(): number {
  syntheticIdCounter += 1;
  return -(Date.now() * 1000 + syntheticIdCounter);
}

/** "M:SS.sss" or "SS.sss" -> ten-thousandths of a second, matching curated_race_results.average_lap_ten_thousandths/best_lap_ten_thousandths. Blank/unparseable -> null (both columns are optional). */
function parseLapTimeToTenThousandths(v: string): number | null {
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

type RowGetter = (row: string[], name: string) => string;

/** Bulk, read-only context every importer's resolveRoundIdentity() call needs — fetched once per CSV upload, not once per group. */
interface RoundLookupContext {
  circuits: { id: string; name: string }[];
  seasons: { id: string; name: string }[];
  events: { id: string; circuit_id: string | null; event_date: string }[];
  importByKey: Map<string, number>;
}

interface RoundIdentity {
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
  status: string;
  strengthOfField: number | null;
  isExhibition: boolean;
  eventId: string | null;
}

/**
 * Resolves the round-level fields shared by every result CSV's first row in
 * a group (circuit/layout/season/date/time/format/status/SOF/exhibition),
 * validates the circuit/season/date actually match something, and resolves
 * curated_rounds.event_id via circuit_id + event_date (see this file's own
 * header comment). Returns null when the group's circuit/season/date can't
 * be resolved — the caller should count the whole group as skipped rather
 * than call writeRoundRow().
 *
 * Deliberately read-only / side-effect-free — it does NOT touch
 * curated_rounds or manual_result_imports itself. That split lets each
 * importer clear its OWN results table (curated_race_results vs.
 * curated_qualifying vs. curated_practice_results) for an already-imported
 * round in between resolving the identity and actually writing the round
 * row, exactly matching this importer's original ordering (clear old result
 * rows, then upsert the round).
 */
function resolveRoundIdentity(importKey: string, get: RowGetter, first: string[], ctx: RoundLookupContext): RoundIdentity | null {
  const circuitName = get(first, 'circuit_name');
  const layoutName = get(first, 'layout');
  const seasonName = get(first, 'season_name');
  const eventDate = get(first, 'event_date');
  const eventTimeRaw = get(first, 'event_time') || '19:00';
  const eventTime = eventTimeRaw.length === 5 ? `${eventTimeRaw}:00` : eventTimeRaw;
  const formatRaw = get(first, 'format').toLowerCase();
  const format = formatRaw === 'endurance' || formatRaw === 'sprint' ? formatRaw : null;
  const statusRaw = get(first, 'status').toLowerCase();
  const status = statusRaw === 'provisional' || statusRaw === 'unofficial' ? statusRaw : 'official';
  const sofRaw = get(first, 'strength_of_field');
  const strengthOfField = sofRaw ? Number(sofRaw) : null;
  const exhibitionRaw = get(first, 'exhibition').toLowerCase();
  const isExhibition = exhibitionRaw === 'yes' || exhibitionRaw === 'true' || exhibitionRaw === '1';

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
  const subsessionId = alreadyImported ? ctx.importByKey.get(importKey)! : nextSyntheticSubsessionId();

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
    status,
    strengthOfField,
    isExhibition,
    eventId,
  };
}

/**
 * Upserts the curated_rounds row (and manual_result_imports link, and
 * exhibition round_overrides flag) for one resolved round identity. Call
 * AFTER clearing the calling importer's own results table for an
 * already-imported round — see resolveRoundIdentity()'s doc comment.
 *
 * `numDrivers`/`updateNumDrivers`: num_drivers is meant to reflect the
 * RACE's grid size, so only the race importer is allowed to overwrite it on
 * an existing round (`updateNumDrivers: true`) — a qualifying- or
 * practice-only re-upload must never clobber that count with its own
 * (usually smaller/different) participant count. On a brand-new round,
 * whichever importer creates it still seeds an initial value — better than
 * leaving it null — since it's the only count available yet.
 */
async function writeRoundRow(
  env: SupabaseEnv,
  accessToken: string,
  identity: RoundIdentity,
  numDrivers: number,
  updateNumDrivers: boolean
): Promise<void> {
  const roundFields = {
    season_id: identity.seasonId,
    start_time: identity.startTimeIso,
    track_name: identity.circuitName,
    season_label: identity.seasonName,
    layout: identity.layoutName || null,
    format: identity.format,
    strength_of_field: identity.strengthOfField,
    status: identity.status,
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
        await restPost(env, accessToken, 'round_overrides', { subsession_id: identity.subsessionId, is_exhibition: true });
      } catch {
        await restPatch(env, accessToken, `round_overrides?subsession_id=eq.${identity.subsessionId}`, { is_exhibition: true });
      }
    } catch (err) {
      console.error(
        `Failed to set the exhibition flag for manual round "${identity.importKey}" (the round itself still imported):`,
        err
      );
    }
  }
}

/** Groups CSV data rows (everything after the header) by their `import_key` column, skipping fully-blank rows and counting keyless rows as skipped. Shared by every importer below. */
function groupRowsByImportKey(rows: string[][], get: RowGetter): { groups: Map<string, string[][]>; skipped: number } {
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

function makeGetter(header: string[]): RowGetter {
  const colIndex = (name: string) => header.indexOf(name);
  return (row: string[], name: string) => {
    const i = colIndex(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };
}

/**
 * Rows are grouped by their `import_key` column — every row sharing the
 * same key is treated as one round (one or more races within it), and gets
 * one synthetic subsession_id between them. Re-uploading a CSV with a key
 * that's already been imported REPLACES that round's curated_race_results
 * rows entirely (deletes then reinserts) rather than merging with what's
 * already there, so a corrected file — including a driver actually removed
 * from it — fully takes over.
 */
export async function importRaceResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][]
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
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
  const seasonCarNumbers = new Map(seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]));

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

    for (const row of groupRows) {
      const carNumberRaw = get(row, 'driver_car_number');
      const carNumber = carNumberRaw ? Number(carNumberRaw) : NaN;
      const driver = Number.isFinite(carNumber)
        ? resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, identity.seasonId, carNumber)
        : undefined;
      const raceNumberRaw = get(row, 'race_number');
      const raceNumber = raceNumberRaw ? Number(raceNumberRaw) : NaN;
      const finishPositionRaw = get(row, 'finish_position');
      const finishPosition = finishPositionRaw ? Number(finishPositionRaw) : NaN;

      if (!driver || !Number.isFinite(raceNumber) || !Number.isFinite(finishPosition)) {
        skipped++;
        continue;
      }
      if (driver.iracing_cust_id == null) {
        console.error(
          `Skipped a manual result row (round "${importKey}", race ${raceNumber}, car #${carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`
        );
        skipped++;
        continue;
      }

      const startingPositionRaw = get(row, 'starting_position');
      const incidentsRaw = get(row, 'incidents');
      const lapsCompleteRaw = get(row, 'laps_complete');
      const lapsLedRaw = get(row, 'laps_led');
      const intervalRaw = get(row, 'interval_ten_thousandths');
      const classNameRaw = get(row, 'class_name');

      try {
        await restPost(env, accessToken, 'curated_race_results', {
          subsession_id: identity.subsessionId,
          race_number: raceNumber,
          cust_id: driver.iracing_cust_id,
          // display_name is NOT NULL on curated_race_results — sourced from
          // this app's own roster rather than the CSV, since the driver was
          // already resolved by car number above and this app's name is the
          // one every other page already shows for them.
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
        });
        imported++;
      } catch (err) {
        console.error(`Failed to import a race-result row (round "${importKey}", race ${raceNumber}, car #${carNumber}):`, err);
        skipped++;
      }
    }
  }

  return { imported, skipped };
}

/**
 * Same import_key/round-resolution scheme as importRaceResultsCsv (see this
 * file's header comment) but writes curated_qualifying instead — one row
 * per driver's qualifying position and best lap. Re-uploading a CSV under an
 * already-imported key replaces that round's curated_qualifying rows only;
 * it never touches curated_race_results/curated_practice_results for the
 * same round.
 */
export async function importQualifyingResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][]
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
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
  const seasonCarNumbers = new Map(seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]));

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
        console.error(`Failed to clear previous qualifying rows for manual round "${importKey}" before re-import:`, err);
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
          `Skipped a manual qualifying row (round "${importKey}", car #${carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`
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
 * Same import_key/round-resolution scheme again, writing curated_practice_
 * results (0078_curated_rounds_event_id_and_practice_results.sql) — one row
 * per driver's practice laps and best lap. There's no finishing/qualifying
 * position to record for a practice session (see that migration's header
 * comment for why `laps` is the one meaningful stat kept instead).
 */
export async function importPracticeResultsCsv(
  env: SupabaseEnv,
  accessToken: string,
  rows: string[][]
): Promise<RaceResultsImportOutcome> {
  let imported = 0;
  let skipped = 0;
  if (rows.length < 2) return { imported, skipped };

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
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
  const seasonCarNumbers = new Map(seasonCarNumberRows.map((r) => [`${r.driver_id}:${r.season_id}`, r.car_number]));

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
        await restDelete(env, accessToken, `curated_practice_results?subsession_id=eq.${identity.subsessionId}`);
      } catch (err) {
        console.error(`Failed to clear previous practice rows for manual round "${importKey}" before re-import:`, err);
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
          `Skipped a manual practice row (round "${importKey}", car #${carNumber}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`
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
