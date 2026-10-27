import { editIncidentReportSubmission, type EditSubmissionResult } from '../incidentReports';
import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** The `?submission=` value the reports panel reads back after an Edit Submission save. */
export type SubmissionFlash = 'updated' | 'unchanged' | 'notopen' | 'notfound' | 'invalid' | 'failed';

export const SUBMISSION_FLASH_MESSAGES: Record<SubmissionFlash, { ok: boolean; message: string }> = {
  updated: { ok: true, message: 'Submission updated.' },
  unchanged: { ok: true, message: 'Nothing changed, so the submission was left as it was.' },
  notopen: { ok: false, message: "This report is no longer open, so it can't be edited." },
  notfound: { ok: false, message: 'That incident report no longer exists.' },
  invalid: {
    ok: false,
    message:
      "Couldn't save the submission — it needs a race, a lap from 0 to 1000, the turns and 1 to 100 cars.",
  },
  failed: { ok: false, message: "Couldn't save the submission right now. Please try again." },
};

/** Which flash a save's result shows. */
export function submissionFlashFor(result: EditSubmissionResult): SubmissionFlash {
  if (result.ok) return result.changed ? 'updated' : 'unchanged';
  if (result.code === 'REPORT_NOT_OPEN') return 'notopen';
  if (result.code === 'REPORT_NOT_FOUND') return 'notfound';
  return result.code === 'INVALID' ? 'invalid' : 'failed';
}

/** The fields as the Edit Submission popup posts them; the database checks them all again. */
export function readSubmissionForm(form: FormData): {
  report_id: string;
  session: string;
  lap: number;
  turn: string;
  driver_ids: string[];
} {
  const lapText = String(form.get('lap') ?? '').trim();
  return {
    report_id: String(form.get('report_id') ?? ''),
    session: String(form.get('session') ?? ''),
    lap: /^\d{1,4}$/.test(lapText) ? Number(lapText) : -1,
    turn: String(form.get('turn') ?? '').trim(),
    driver_ids: form.getAll('involved_driver_ids').map(String),
  };
}

/**
 * `edit-report-submission` (Admin or Staff): corrects an open report's race, lap, turns and cars
 * (BR4.1-BR4.5). The database locks the report, refuses one that is no longer open and logs the change in the
 * same transaction; this only reads the form and says how it went.
 */
export async function handleEditReportSubmission(
  ctx: IncidentActionContext,
  form: FormData,
): Promise<IncidentActionRedirect> {
  const input = readSubmissionForm(form);
  const result = input.report_id
    ? await editIncidentReportSubmission(ctx.supabaseEnv, ctx.accessToken, input)
    : ({ ok: false, code: 'REPORT_NOT_FOUND', field: null, message: '' } as const);
  const url = new URL(ctx.url);
  url.searchParams.delete('review');
  url.searchParams.set('submission', submissionFlashFor(result));
  return ctx.redirect(`${ctx.shellPath}${url.search}#${REPORTS_ANCHOR}`);
}
