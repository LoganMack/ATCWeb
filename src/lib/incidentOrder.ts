/**
 * The round's incident report order for the admin Reported Incidents screen (BR2.1, BR2.7). The database works
 * it out once (private.incident_report_order); the public Incident Submissions page reads the same numbers
 * through incident_submissions(), so neither screen sorts reports itself.
 */

import { restRpc, withAccessToken, type SupabaseEnv } from './db/client';

export interface ReportOrderRow {
  report_id: string;
  position: number;
  /** Null for a dismissed report. */
  number: number | null;
}

/** Admin or Staff: every report's position and number. Null when the read fails, so the page can still list. */
export async function getIncidentReportOrder(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
): Promise<ReportOrderRow[] | null> {
  try {
    return await restRpc<ReportOrderRow[]>(withAccessToken(env, accessToken), 'incident_report_order', {
      p_subsession_id: subsessionId,
    });
  } catch (err) {
    console.error('incident_report_order failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

interface OrderableReport {
  id: string;
  created_at: string;
}

/**
 * Puts reports in the database's order and returns each numbered report's number. A report the order doesn't
 * know (submitted between the two reads) goes last, unnumbered. With no order at all (a failed read) the
 * reports are listed by submission time with no numbers, rather than numbered by a second rule.
 */
export function applyReportOrder<T extends OrderableReport>(
  reports: readonly T[],
  orderRows: readonly ReportOrderRow[] | null,
): { reports: T[]; numbers: Map<string, number> } {
  const byId = new Map((orderRows ?? []).map((row) => [row.report_id, row]));
  const bySubmission = (a: T, b: T) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const known = reports
    .filter((r) => byId.has(r.id))
    .sort((a, b) => byId.get(a.id)!.position - byId.get(b.id)!.position);
  const unknown = reports.filter((r) => !byId.has(r.id)).sort(bySubmission);
  const numbers = new Map<string, number>();
  for (const r of known) {
    const n = byId.get(r.id)!.number;
    if (n !== null && n !== undefined) numbers.set(r.id, n);
  }
  return { reports: [...known, ...unknown], numbers };
}
