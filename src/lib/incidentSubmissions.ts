/**
 * The public "Incident Submissions" page: an unposted round's incident reports, readable by everyone through
 * incident_submissions() (20261110120000_incident_submissions.sql, numbered by the shared order since
 * 20261111120000). The database returns only the report id, its number, session, lap and involved cars, so no
 * description, reporter, turn or decision can reach this page, and dismissed reports are left out.
 * A signed-in driver named in a report gets the profile's Add Comment button on that row (my_incidents()).
 */

import { type SupabaseEnv, restGet, restRpc } from './db/client';
import { incidentSessionLabel, type IncidentManagementRow } from './incidents';

/** One row of incident_submissions(), as PostgREST returns it. */
export interface IncidentSubmissionDbRow {
  id: string;
  submission_number: number;
  session: string;
  lap: number | null;
  involved_cars: string[] | null;
}

/**
 * The submissions table's columns: the posted Incident Report's table without Driver, PP, Time, Pts, Pos Δ
 * and Pts Δ, which would reveal decisions. The last column holds the involved driver's Add Comment button.
 */
export const INCIDENT_SUBMISSION_COLUMNS = ['#', 'Lap', 'Involved'] as const;
export const INCIDENT_REPORT_ONLY_COLUMNS = ['Driver', 'PP', 'Time', 'Pts', 'Pos Δ', 'Pts Δ'] as const;

/** What the Add Comment popup shows for a row; never the report's description. */
export interface IncidentSubmissionComment {
  roundLabel: string;
  sessionLabel: string;
  lap: string;
  turn: string;
}

/**
 * One column width set shared by every session table on the page (BR2.9), so the columns line up from table
 * to table. Tailwind width classes for the <col> elements, in INCIDENT_SUBMISSION_COLUMNS order plus actions.
 */
export const INCIDENT_SUBMISSION_COL_WIDTHS = ['w-14', 'w-16', '', 'w-36'] as const;

export interface IncidentSubmissionCar {
  car: string;
  /** The signed-in viewer's own driver's car (BR2.10). */
  mine: boolean;
}

export interface IncidentSubmissionRow {
  id: string;
  number: number;
  numberLabel: string;
  lap: number | null;
  /** "#04, #12", or "—" when no car is listed. */
  involvedLabel: string;
  /** The listed cars one by one, so the viewer's own can be picked out. */
  involved: IncidentSubmissionCar[];
  /** Set when the viewer is involved and may still comment. */
  comment: IncidentSubmissionComment | null;
  /** The viewer is involved and has already commented. */
  commentSent: boolean;
}

export interface IncidentSubmissionSession {
  key: string;
  label: string;
  rows: IncidentSubmissionRow[];
}

/** Event order (BR2.8): Practice, Qualifying, Race 1, Race 2, …, then anything else. */
function sessionOrder(key: string): [number, number] {
  const [type, num] = key.split(':');
  if (type === 'practice') return [0, 0];
  if (type === 'qualifying') return [1, 0];
  if (type === 'race') return [2, Number(num) || 0];
  return [3, 0];
}

/** Car numbers compare as text: '04' and '4' are different cars. */
function sameCar(a: string, b: string | null | undefined): boolean {
  return b !== null && b !== undefined && a.trim() !== '' && a.trim() === String(b).trim();
}

/**
 * The page's tables, one per session in event order, rows by number (the database's shared order). `mine` is
 * the viewer's my_incidents() list (null when signed out or unlinked); only its pending reports for this round
 * add a comment button. `viewerCar` is the viewer's own driver's car number, marked in the Involved column.
 */
export function buildIncidentSubmissionsView(
  rows: IncidentSubmissionDbRow[],
  mine: IncidentManagementRow[] | null,
  viewerCar: string | null = null,
): IncidentSubmissionSession[] {
  const myPending = new Map(
    (mine ?? []).filter((row) => row.kind === 'pending').map((row) => [row.id, row] as const),
  );
  const bySession = new Map<string, IncidentSubmissionRow[]>();
  for (const row of rows) {
    const my = myPending.get(row.id);
    const cars = row.involved_cars ?? [];
    const list = bySession.get(row.session) ?? [];
    list.push({
      id: row.id,
      number: row.submission_number,
      numberLabel: String(row.submission_number),
      lap: row.lap,
      involvedLabel: cars.length > 0 ? cars.map((car) => `#${car}`).join(', ') : '—',
      involved: cars.map((car) => ({ car, mine: sameCar(car, viewerCar) })),
      comment:
        my && my.canComment
          ? {
              roundLabel: my.roundLabel,
              sessionLabel: my.sessionLabel,
              lap: my.lap !== null ? String(my.lap) : '—',
              turn: my.turn ?? '—',
            }
          : null,
      commentSent: my?.commentSent ?? false,
    });
    bySession.set(row.session, list);
  }
  return [...bySession.entries()]
    .sort(([a], [b]) => {
      const [ta, na] = sessionOrder(a);
      const [tb, nb] = sessionOrder(b);
      return ta - tb || na - nb || a.localeCompare(b);
    })
    .map(([key, list]) => ({
      key,
      label: incidentSessionLabel(key),
      rows: list.sort((a, b) => a.number - b.number),
    }));
}

/**
 * The car number of the viewer's linked driver, to mark it in the Involved column; null when unknown. Car
 * numbers are public. Never throws: without it the tables just show no highlight.
 */
export async function getViewerCarNumber(env: SupabaseEnv, driverId: string | null): Promise<string | null> {
  if (!driverId) return null;
  try {
    const rows = await restGet<{ car_number: number | string | null }[]>(
      env,
      `drivers_shown?select=car_number&id=eq.${encodeURIComponent(driverId)}`,
    );
    const car = rows[0]?.car_number;
    return car === null || car === undefined ? null : String(car);
  } catch (err) {
    console.error('Failed to read the viewer’s car number:', err instanceof Error ? err.message : 'unknown');
    return null;
  }
}

/** The round's submissions; empty once it is posted. Throws on failure; the page shows its load error. */
export function getIncidentSubmissions(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<IncidentSubmissionDbRow[]> {
  return restRpc<IncidentSubmissionDbRow[]>(env, 'incident_submissions', { p_subsession_id: subsessionId });
}
