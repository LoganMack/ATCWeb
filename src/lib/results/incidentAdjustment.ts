/**
 * Words for adjusted incident counts on the Race Results page (US9.2) and the banner after an Edit Results
 * save (US9.1). Pure, so the page and tests share it.
 */

/** "Incidents adjusted from X to Y.", or null when the count was never changed. */
export function incidentAdjustmentLabel(
  original: number | null | undefined,
  current: number | null | undefined,
): string | null {
  if (original === null || original === undefined || current === null || current === undefined) return null;
  if (original === current) return null;
  return `Incidents adjusted from ${original} to ${current}.`;
}

export type IncidentsResultCode =
  | 'saved'
  | 'unchanged'
  | 'scoring_issue'
  | 'not_full_admin'
  | 'invalid_count'
  | 'not_in_race'
  | 'season_locked'
  | 'save_failed';

export const INCIDENTS_RESULT_CODES: readonly IncidentsResultCode[] = [
  'saved',
  'unchanged',
  'scoring_issue',
  'not_full_admin',
  'invalid_count',
  'not_in_race',
  'season_locked',
  'save_failed',
];

export function isIncidentsResultCode(value: string | null): value is IncidentsResultCode {
  return value !== null && (INCIDENTS_RESULT_CODES as readonly string[]).includes(value);
}

/** The banner for a save result; `driverName` names the row the database refused, when known. */
export function incidentsResultMessage(
  code: IncidentsResultCode,
  driverName?: string | null,
): { tone: 'success' | 'warning' | 'error'; text: string } {
  const forDriver = driverName ? ` for ${driverName}` : '';
  switch (code) {
    case 'saved':
      return { tone: 'success', text: 'Incident counts saved.' };
    case 'unchanged':
      return { tone: 'success', text: 'No incident counts changed.' };
    case 'scoring_issue':
      return {
        tone: 'warning',
        text: "Incident counts saved, but the round couldn't be scored. Check the round's results and season setup.",
      };
    case 'not_full_admin':
      return { tone: 'error', text: 'Only full admins can edit results.' };
    case 'invalid_count':
      return {
        tone: 'error',
        text: `Invalid incident count${forDriver}. Use a whole number from 0 to 999. Nothing was saved.`,
      };
    case 'not_in_race':
      return {
        tone: 'error',
        text: `${driverName ?? 'A driver'} is not in this race any more. Reload the page and try again. Nothing was saved.`,
      };
    case 'season_locked':
      return {
        tone: 'error',
        text: "This round's season is locked, so its results can't change. Nothing was saved.",
      };
    case 'save_failed':
      return { tone: 'error', text: "Incident counts couldn't be saved. Try again." };
  }
}
