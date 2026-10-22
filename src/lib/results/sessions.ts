import { restGet, type SupabaseEnv } from '../db/client';
import { formatLapTime } from '../db/circuits';
import { driversSelect, type DriverBasic } from './rows';

export interface QualifyingRow {
  driver: DriverBasic;
  /** From `race_score_results.class_id` for this driver in this round — NOT `curated_qualifying.car_class_name` (an unverified text field never cross-checked against this app's class names). Null when this driver qualified but has no `race_score_results` row anywhere in the round (e.g. DNS'd every race, or unrostered) — can't be placed in a per-class view, but still shown in Overall. */
  classId: number | null;
  qualPosition: number | null;
  /** "1:42.512"-formatted best qualifying lap (see `formatLapTime`), from `curated_qualifying.best_lap_ten_thousandths`. "—" when the pipeline has no time for this driver. */
  bestLapFormatted: string;
  bestLapTenThousandths: number | null;
  /** True for a cust_id in `curated_qualifying` with no matching `drivers` row — same concept as `RaceResultRow.notInRoster`, falls back to `curated_qualifying.display_name`. */
  notInRoster: boolean;
}

interface CuratedQualifyingRow {
  subsession_id: number;
  cust_id: number;
  display_name: string;
  car_class_name: string | null;
  qual_position: number | null;
  best_lap_ten_thousandths: number | null;
}

/**
 * One round's qualifying: one session per round, so just Overall (by qual_position) and Per Class (the same
 * rows filtered and re-sorted).
 */
export async function getQualifyingForSubsession(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<{ overall: QualifyingRow[]; byClass: Map<number, QualifyingRow[]> }> {
  const [qualRows, drivers, classScores] = await Promise.all([
    restGet<CuratedQualifyingRow[]>(
      env,
      `curated_qualifying?select=subsession_id,cust_id,display_name,car_class_name,qual_position,best_lap_ten_thousandths&subsession_id=eq.${subsessionId}`,
    ),
    driversSelect(env, { includeAi: true }),
    restGet<{ driver_id: string; class_id: number }[]>(
      env,
      `race_score_results_public?select=driver_id,class_id&subsession_id=eq.${subsessionId}`,
    ),
  ]);

  const driverByCustId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.iracing_cust_id as number, d]),
  );
  // First class_id seen per driver in this round — a driver's class doesn't
  // change race-to-race within one round, so any race_score_results row for them
  // here is as good as another.
  const classIdByDriverId = new Map<string, number>();
  for (const s of classScores) {
    if (!classIdByDriverId.has(s.driver_id)) classIdByDriverId.set(s.driver_id, s.class_id);
  }

  const rows: QualifyingRow[] = qualRows.map((q) => {
    const driver = driverByCustId.get(q.cust_id);
    const bestLapSeconds = q.best_lap_ten_thousandths !== null ? q.best_lap_ten_thousandths / 10000 : null;
    if (!driver) {
      return {
        driver: {
          id: `unrostered:${q.cust_id}`,
          name: q.display_name,
          car_number: null,
          photo_url: null,
          iracing_cust_id: q.cust_id,
          is_rookie: false,
          nationality_1: null,
          nationality_2: null,
          is_ai: false,
        },
        classId: null,
        qualPosition: q.qual_position,
        bestLapFormatted: formatLapTime(bestLapSeconds),
        bestLapTenThousandths: q.best_lap_ten_thousandths,
        notInRoster: true,
      };
    }
    return {
      driver,
      classId: classIdByDriverId.get(driver.id) ?? null,
      qualPosition: q.qual_position,
      bestLapFormatted: formatLapTime(bestLapSeconds),
      bestLapTenThousandths: q.best_lap_ten_thousandths,
      notInRoster: false,
    };
  });

  const byPos = (a: QualifyingRow, b: QualifyingRow) =>
    (a.qualPosition ?? Infinity) - (b.qualPosition ?? Infinity);
  const overall = [...rows].sort(byPos);

  const byClass = new Map<number, QualifyingRow[]>();
  for (const row of rows) {
    if (row.classId === null) continue;
    if (!byClass.has(row.classId)) byClass.set(row.classId, []);
    byClass.get(row.classId)!.push(row);
  }
  for (const classRows of byClass.values()) classRows.sort(byPos);

  return { overall, byClass };
}

export interface PracticeRow {
  driver: DriverBasic;
  /** Same "from race_score_results.class_id, not the curated table's own text field" reasoning as QualifyingRow.classId. */
  classId: number | null;
  /** curated_practice_results has no stored position field at all (a practice session isn't a grid) — this is derived here purely by ranking best lap time ascending across the whole session, then reused unchanged in the per-class view rather than re-ranked to 1..N within a class filter, mirroring how QualifyingRow.qualPosition (a real stored field) is reused as-is in getQualifyingForSubsession's byClass. Null for a driver with no recorded best lap. */
  position: number | null;
  /** "1:42.512"-formatted best practice lap (see `formatLapTime`), from `curated_practice_results.best_lap_ten_thousandths`. "—" when the pipeline has no time for this driver. */
  bestLapFormatted: string;
  bestLapTenThousandths: number | null;
  /** Total laps completed this practice session, from `curated_practice_results.laps` — practice has no finishing/qualifying position to show, so this is the one meaningful "how much running did they get" stat it does have. Null when the pipeline didn't record a lap count. */
  laps: number | null;
  notInRoster: boolean;
}

interface CuratedPracticeRow {
  subsession_id: number;
  cust_id: number;
  display_name: string;
  car_class_name: string | null;
  best_lap_ten_thousandths: number | null;
  laps: number | null;
}

/**
 * One round's practice results — same shape and approach as
 * getQualifyingForSubsession just above, backed by curated_practice_results
 * (0078_curated_rounds_event_id_and_practice_results.sql) instead of
 * curated_qualifying. See PracticeRow.position for how "position" is
 * derived here despite the source table having no such column.
 */
export async function getPracticeForSubsession(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<{ overall: PracticeRow[]; byClass: Map<number, PracticeRow[]> }> {
  const [practiceRows, drivers, classScores] = await Promise.all([
    restGet<CuratedPracticeRow[]>(
      env,
      `curated_practice_results?select=subsession_id,cust_id,display_name,car_class_name,best_lap_ten_thousandths,laps&subsession_id=eq.${subsessionId}`,
    ),
    driversSelect(env, { includeAi: true }),
    restGet<{ driver_id: string; class_id: number }[]>(
      env,
      `race_score_results_public?select=driver_id,class_id&subsession_id=eq.${subsessionId}`,
    ),
  ]);

  const driverByCustId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.iracing_cust_id as number, d]),
  );
  // First class_id seen per driver in this round — same reasoning as
  // getQualifyingForSubsession's identical block.
  const classIdByDriverId = new Map<string, number>();
  for (const s of classScores) {
    if (!classIdByDriverId.has(s.driver_id)) classIdByDriverId.set(s.driver_id, s.class_id);
  }

  // Rank by best lap ascending (fastest first; no-lap-time rows sort last)
  // across the WHOLE session before building rows, so `position` reflects
  // everyone regardless of iteration order — see PracticeRow.position.
  const ranked = [...practiceRows].sort((a, b) => {
    if (a.best_lap_ten_thousandths === null && b.best_lap_ten_thousandths === null) return 0;
    if (a.best_lap_ten_thousandths === null) return 1;
    if (b.best_lap_ten_thousandths === null) return -1;
    return a.best_lap_ten_thousandths - b.best_lap_ten_thousandths;
  });
  const positionByCustId = new Map<number, number>();
  ranked.forEach((r, i) => {
    if (r.best_lap_ten_thousandths !== null) positionByCustId.set(r.cust_id, i + 1);
  });

  const rows: PracticeRow[] = practiceRows.map((p) => {
    const driver = driverByCustId.get(p.cust_id);
    const bestLapSeconds = p.best_lap_ten_thousandths !== null ? p.best_lap_ten_thousandths / 10000 : null;
    const position = positionByCustId.get(p.cust_id) ?? null;
    if (!driver) {
      return {
        driver: {
          id: `unrostered:${p.cust_id}`,
          name: p.display_name,
          car_number: null,
          photo_url: null,
          iracing_cust_id: p.cust_id,
          is_rookie: false,
          nationality_1: null,
          nationality_2: null,
          is_ai: false,
        },
        classId: null,
        position,
        bestLapFormatted: formatLapTime(bestLapSeconds),
        bestLapTenThousandths: p.best_lap_ten_thousandths,
        laps: p.laps,
        notInRoster: true,
      };
    }
    return {
      driver,
      classId: classIdByDriverId.get(driver.id) ?? null,
      position,
      bestLapFormatted: formatLapTime(bestLapSeconds),
      bestLapTenThousandths: p.best_lap_ten_thousandths,
      laps: p.laps,
      notInRoster: false,
    };
  });

  const byPracticePos = (a: PracticeRow, b: PracticeRow) =>
    (a.position ?? Infinity) - (b.position ?? Infinity);
  const overall = [...rows].sort(byPracticePos);

  const byClass = new Map<number, PracticeRow[]>();
  for (const row of rows) {
    if (row.classId === null) continue;
    if (!byClass.has(row.classId)) byClass.set(row.classId, []);
    byClass.get(row.classId)!.push(row);
  }
  for (const classRows of byClass.values()) classRows.sort(byPracticePos);

  return { overall, byClass };
}
