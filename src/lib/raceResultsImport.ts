/**
 * Manual Race Results CSV import — writes RAW PER-DRIVER FINISH DATA only,
 * into curated_rounds (the round itself) and curated_race_results (each
 * driver's finish position, laps, incidents, lap times — the same shape the
 * real iRacing-results pipeline populates). It deliberately does NOT write
 * to race_scores: that table holds computed POINTS, produced by the
 * database's own recalculate_race_scores() from a season's scoring ruleset
 * (see Admin > Rulesets) — this importer's job ends at getting the raw
 * results into the database, not at scoring them. A round imported here
 * shows up on Race Results immediately; it will show up in Standings/Career
 * Stats/News Recaps once its season has a scoring ruleset assigned and an
 * admin recalculates that round's scores (that recalculation isn't part of
 * this importer — see the note on Admin > Import for how the two connect).
 *
 * (Earlier versions of this importer also wrote directly into race_scores,
 * requiring the admin to hand-supply every scoring field — finish_points,
 * class_points, etc. That was a mismatch: those are the scoring engine's
 * output, not raw data, and writing them here made manually-imported rows
 * indistinguishable from real computed ones. Raw-only is the correct scope.)
 *
 * This is still the one importer of the four (Events, Circuits, News, Race
 * Results) that writes directly into pipeline-owned tables — see
 * results.ts's own header comment, and 0004_champions.sql/0014_penalties.sql/
 * 0018_curated_rounds_layout.sql for the rule this deliberately breaks. This
 * is a one-off, Logan-approved exception — see 0028_manual_results_import.sql's
 * header for the reasoning and the negative-subsession_id collision-safety
 * scheme that makes it safe.
 *
 * Meant for exhibition races or one-off events the real pipeline will never
 * see. If a round WILL eventually show up in a real pipeline import, don't
 * use this — a synthetic round and a real one for the same event would show
 * up as two separate rounds in every list on the site (the app has no way
 * to know they're "the same" race).
 *
 * ONE IMPORTANT LIMITATION, surfaced to the admin via skipped-row counts
 * rather than failing the whole upload: curated_race_results identifies a
 * driver by `cust_id` (their iRacing customer id), never by this app's own
 * driver_id — and every reader in results.ts (see getRoundResults/
 * getSeasonOverallContext) joins a curated_race_results row to a driver via
 * `drivers.iracing_cust_id`, not a real foreign key. A driver with no
 * iracing_cust_id set on their Roster profile literally cannot be joined
 * this way — any CSV row for such a driver is skipped. Set the driver's
 * iRacing Customer ID first (Admin > Roster) before importing their results.
 *
 * A CSV row identifies WHICH driver it's about via `driver_name` and/or
 * `driver_car_number` — either alone resolves against the Roster (see
 * resolveImportDriver below); providing both requires them to agree, so a
 * typo in one doesn't silently get resolved by trusting the other. The
 * `display_name` actually written to curated_race_results always comes from
 * the matched Roster row, not the CSV cell, so every other page stays
 * consistent regardless of what the CSV's driver_name column says.
 *
 * `reason_out` is optional and mirrors the real iRacing pipeline's own
 * values ('Running', 'Disconnected', 'Retired', 'Disqualified',
 * 'DQ/Scoring Invalidated') — it's what recalculate_race_scores() reads to
 * decide DSQ (0032_fix_recalculate_race_scores.sql), so it's the only way a
 * manually-imported round can represent a DSQ the same way a real pipeline
 * import would. Left blank, it behaves exactly as it did before this column
 * existed (null, i.e. finished normally).
 */
import { restGet, restGetAuthed, restPost, restPatch, restDelete, getCircuits, getSeasons, type SupabaseEnv } from './supabase';

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
 * Identifies a CSV row's driver by driver_name and/or driver_car_number —
 * either alone is enough (name lets an admin fill this in without knowing
 * everyone's car number by heart; car number stays supported for CSVs built
 * the old way, before driver_name existed as a column). If both are given
 * they must agree; a mismatch is treated as a data-entry error rather than
 * silently trusting one over the other, since guessing wrong here would
 * attribute a result to the wrong driver.
 */
function resolveImportDriver(
  drivers: ImportDriver[],
  nameRaw: string,
  carNumberRaw: string
): { driver?: ImportDriver; conflict?: boolean } {
  const carNumber = carNumberRaw ? Number(carNumberRaw) : NaN;
  const byCarNumber = Number.isFinite(carNumber) ? drivers.find((d) => d.car_number === carNumber) : undefined;
  const byName = nameRaw.trim() ? drivers.find((d) => d.name.toLowerCase() === nameRaw.trim().toLowerCase()) : undefined;
  if (byName && byCarNumber && byName.id !== byCarNumber.id) {
    return { conflict: true };
  }
  return { driver: byName ?? byCarNumber };
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
  const colIndex = (name: string) => header.indexOf(name);
  const get = (row: string[], name: string) => {
    const i = colIndex(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const [circuits, seasons, drivers, existingImports] = await Promise.all([
    getCircuits(env),
    getSeasons(env),
    getDriversForImport(env),
    getManualResultImports(env, accessToken),
  ]);
  const importByKey = new Map(existingImports.map((r) => [r.import_key, r.subsession_id]));

  const groups = new Map<string, string[][]>();
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

  for (const [importKey, groupRows] of groups) {
    const first = groupRows[0];
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

    const circuit = circuits.find((c) => c.name.toLowerCase() === circuitName.toLowerCase());
    const season = seasons.find((s) => s.name.toLowerCase() === seasonName.toLowerCase());
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate);

    if (!circuit || !season || !validDate) {
      // Unrecognized circuit/season name or malformed date — this file's
      // header comment on `resolveLayout` already tolerates a `layout`
      // value that doesn't match any circuit_layouts row (it just fails to
      // resolve a specific one), so `layoutName` isn't validated here.
      skipped += groupRows.length;
      continue;
    }

    const alreadyImported = importByKey.has(importKey);
    const subsessionId = alreadyImported ? importByKey.get(importKey)! : nextSyntheticSubsessionId();

    if (alreadyImported) {
      try {
        await restDelete(env, accessToken, `curated_race_results?subsession_id=eq.${subsessionId}`);
      } catch (err) {
        console.error(`Failed to clear previous rows for manual round "${importKey}" before re-import:`, err);
        skipped += groupRows.length;
        continue;
      }
    }

    const startTimeIso = `${eventDate}T${eventTime}.000Z`;

    // Resolve every row's driver up front (name and/or car number — see
    // resolveImportDriver above) so num_drivers below counts actual matched
    // roster drivers rather than raw car-number strings, which would
    // undercount any row identified by name alone.
    const resolvedRows = groupRows.map((row) => {
      const nameRaw = get(row, 'driver_name');
      const carNumberRaw = get(row, 'driver_car_number');
      const { driver, conflict } = resolveImportDriver(drivers, nameRaw, carNumberRaw);
      return { row, nameRaw, carNumberRaw, driver, conflict };
    });
    const matchedDriverIds = new Set(
      resolvedRows.filter((r) => r.driver && !r.conflict).map((r) => r.driver!.id)
    );

    try {
      if (alreadyImported) {
        await restPatch(env, accessToken, `curated_rounds?subsession_id=eq.${subsessionId}`, {
          season_id: season.id,
          start_time: startTimeIso,
          track_name: circuit.name,
          season_label: season.name,
          layout: layoutName || null,
          format,
          strength_of_field: strengthOfField,
          num_drivers: matchedDriverIds.size,
          status,
        });
      } else {
        await restPost(env, accessToken, 'curated_rounds', {
          subsession_id: subsessionId,
          season_id: season.id,
          start_time: startTimeIso,
          track_name: circuit.name,
          season_label: season.name,
          round_number: null,
          layout: layoutName || null,
          format,
          strength_of_field: strengthOfField,
          num_drivers: matchedDriverIds.size,
          status,
        });
        await restPost(env, accessToken, 'manual_result_imports', { import_key: importKey, subsession_id: subsessionId });
      }
    } catch (err) {
      console.error(`Failed to write curated_rounds for manual round "${importKey}":`, err);
      skipped += groupRows.length;
      continue;
    }

    try {
      if (isExhibition) {
        try {
          await restPost(env, accessToken, 'round_overrides', { subsession_id: subsessionId, is_exhibition: true });
        } catch {
          await restPatch(env, accessToken, `round_overrides?subsession_id=eq.${subsessionId}`, { is_exhibition: true });
        }
      }
    } catch (err) {
      console.error(`Failed to set the exhibition flag for manual round "${importKey}" (the round itself still imported):`, err);
    }

    for (const { row, nameRaw, carNumberRaw, driver, conflict } of resolvedRows) {
      const raceNumberRaw = get(row, 'race_number');
      const raceNumber = raceNumberRaw ? Number(raceNumberRaw) : NaN;
      const finishPositionRaw = get(row, 'finish_position');
      const finishPosition = finishPositionRaw ? Number(finishPositionRaw) : NaN;
      const whoDescription = nameRaw || (carNumberRaw ? `car #${carNumberRaw}` : '(no driver_name or driver_car_number given)');

      if (conflict) {
        console.error(
          `Skipped a manual result row (round "${importKey}", race ${raceNumberRaw || '?'}): driver_name "${nameRaw}" and driver_car_number "${carNumberRaw}" match two different roster drivers — fix the mismatch and re-import.`
        );
        skipped++;
        continue;
      }
      if (!driver || !Number.isFinite(raceNumber) || !Number.isFinite(finishPosition)) {
        console.error(
          `Skipped a manual result row (round "${importKey}", race ${raceNumberRaw || '?'}): could not match driver ${whoDescription} to a roster entry, or race_number/finish_position was missing/invalid.`
        );
        skipped++;
        continue;
      }
      if (driver.iracing_cust_id == null) {
        console.error(
          `Skipped a manual result row (round "${importKey}", race ${raceNumber}, ${whoDescription}): this driver has no iRacing Customer ID set — set one on their Roster profile before importing their results.`
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
      const reasonOutRaw = get(row, 'reason_out');

      try {
        await restPost(env, accessToken, 'curated_race_results', {
          subsession_id: subsessionId,
          race_number: raceNumber,
          cust_id: driver.iracing_cust_id,
          // display_name is NOT NULL on curated_race_results — sourced from
          // this app's own roster rather than the CSV's driver_name cell, so
          // it always matches the name every other page shows for them (the
          // driver was already resolved above by name and/or car number, so
          // this doesn't lose anything if the CSV cell has a nickname/typo).
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
          // What recalculate_race_scores() reads to decide DSQ (see
          // supabase/migrations/0032_fix_recalculate_race_scores.sql) —
          // 'Disqualified'/'DQ/Scoring Invalidated' zero the driver's whole
          // round, matching the real iRacing pipeline's own values. Blank
          // means "finished normally," same behavior as before this column
          // existed (the field was always left null).
          reason_out: reasonOutRaw || null,
        });
        imported++;
      } catch (err) {
        console.error(`Failed to import a race-result row (round "${importKey}", race ${raceNumber}, ${whoDescription}):`, err);
        skipped++;
      }
    }
  }

  return { imported, skipped };
}
