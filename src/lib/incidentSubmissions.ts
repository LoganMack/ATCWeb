/**
 * The public "Incident Submissions" page: an unposted round's incident reports, readable by everyone through
 * incident_submissions() (20261110120000_incident_submissions.sql). The database returns only the report id,
 * its number, session, lap and involved cars, so no description, reporter or decision can reach this page.
 * A signed-in driver named in a report gets the profile's Add Comment button on that row (my_incidents()).
 */

import { type SupabaseEnv, restRpc } from './db/client';
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

export interface IncidentSubmissionRow {
  id: string;
  numberLabel: string;
  lap: number | null;
  /** "#04, #12", or "—" when no car is listed. */
  involvedLabel: string;
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

/** Race 1, Race 2, …, then Qualifying, Practice, then anything else. */
function sessionOrder(key: string): [number, number] {
  const [type, num] = key.split(':');
  if (type === 'race') return [0, Number(num) || 0];
  if (type === 'qualifying') return [1, 0];
  if (type === 'practice') return [2, 0];
  return [3, 0];
}

/**
 * The page's tables, one per session in race order. `mine` is the viewer's my_incidents() list (null when
 * signed out or unlinked); only its pending reports for this round add a comment button.
 */
export function buildIncidentSubmissionsView(
  rows: IncidentSubmissionDbRow[],
  mine: IncidentManagementRow[] | null,
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
      numberLabel: String(row.submission_number),
      lap: row.lap,
      involvedLabel: cars.length > 0 ? cars.map((car) => `#${car}`).join(', ') : '—',
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
    .map(([key, list]) => ({ key, label: incidentSessionLabel(key), rows: list }));
}

/** The round's submissions; empty once it is posted. Throws on failure; the page shows its load error. */
export function getIncidentSubmissions(
  env: SupabaseEnv,
  subsessionId: number,
): Promise<IncidentSubmissionDbRow[]> {
  return restRpc<IncidentSubmissionDbRow[]>(env, 'incident_submissions', { p_subsession_id: subsessionId });
}
