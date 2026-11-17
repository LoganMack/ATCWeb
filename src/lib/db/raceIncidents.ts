/**
 * Full-admin incident count edits on the Race Results page (US9.1). The write goes through
 * set_race_incidents (migration 20261119120000), which checks the caller, keeps the imported original in
 * race_incident_adjustments and re-scores the round in one transaction.
 */
import type { SupabaseEnv } from './client';

/** Most rows one save may change; the database refuses more. */
export const MAX_INCIDENT_CHANGES = 200;
export const MAX_INCIDENTS = 999;

export interface IncidentChange {
  cust_id: number;
  incidents: number;
}

export type SaveIncidentsCode =
  'not_full_admin' | 'invalid_count' | 'not_in_race' | 'season_locked' | 'save_failed';

export type SaveIncidentsResult =
  | { ok: true; changed: number; scoringIssue: string | null }
  | { ok: false; code: SaveIncidentsCode; custId: number | null };

const FIELD = /^incidents\[(\d{1,16})\]$/;
const WHOLE = /^\d{1,3}$/;

/**
 * Reads the `incidents[<cust_id>]` fields. Null when any field is malformed: a blank, a decimal, a negative
 * value, over 999, a bad key, or more rows than one save allows. The database checks all of it again.
 */
export function parseIncidentChanges(form: FormData): IncidentChange[] | null {
  const changes: IncidentChange[] = [];
  const seen = new Set<number>();
  for (const [key, raw] of form.entries()) {
    if (!key.startsWith('incidents[')) continue;
    const match = FIELD.exec(key);
    if (!match || typeof raw !== 'string') return null;
    const custId = Number(match[1]);
    const value = raw.trim();
    if (!Number.isSafeInteger(custId) || custId <= 0 || seen.has(custId)) return null;
    if (!WHOLE.test(value)) return null;
    const incidents = Number(value);
    if (incidents > MAX_INCIDENTS) return null;
    seen.add(custId);
    changes.push({ cust_id: custId, incidents });
  }
  if (changes.length === 0 || changes.length > MAX_INCIDENT_CHANGES) return null;
  return changes;
}

function codeFor(pgCode: string | undefined): SaveIncidentsCode {
  switch (pgCode) {
    case '42501':
      return 'not_full_admin';
    case '22023':
      return 'invalid_count';
    case 'P0002':
      return 'not_in_race';
    case 'SC001':
      return 'season_locked';
    default:
      return 'save_failed';
  }
}

function custIdFrom(details: unknown): number | null {
  if (typeof details !== 'string' || !/^\d{1,16}$/.test(details)) return null;
  const id = Number(details);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Saves one race's changed counts as the signed-in admin. Never throws. */
export async function saveRaceIncidents(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
  raceNumber: number,
  changes: IncidentChange[],
): Promise<SaveIncidentsResult> {
  let res: Response;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/set_race_incidents`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_subsession_id: subsessionId, p_race_number: raceNumber, p_changes: changes }),
    });
  } catch {
    return { ok: false, code: 'save_failed', custId: null };
  }
  if (!res.ok) {
    let body: { code?: string; details?: unknown } | null = null;
    try {
      body = (await res.json()) as { code?: string; details?: unknown };
    } catch {
      body = null;
    }
    return { ok: false, code: codeFor(body?.code), custId: custIdFrom(body?.details) };
  }
  let body: { changed?: unknown; scoring_issue?: unknown } | null = null;
  try {
    body = (await res.json()) as { changed?: unknown; scoring_issue?: unknown };
  } catch {
    body = null;
  }
  const changed = typeof body?.changed === 'number' ? body.changed : 0;
  const scoringIssue =
    typeof body?.scoring_issue === 'string' && body.scoring_issue.trim() ? body.scoring_issue : null;
  return { ok: true, changed, scoringIssue };
}
