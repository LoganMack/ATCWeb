import { setIncidentReportStatus } from '../incidentReports';
import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** `set-report-status` (admin only): dismiss, reopen or mark logged a driver-submitted report. */
export async function handleSetReportStatus(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, shellPath } = ctx;
  const reportId = String(form.get('report_id') ?? '');
  const status = String(form.get('status') ?? '');
  // Dismissing needs a reason (the dismiss popup's textarea; 0111).
  const dismissalReason = String(form.get('reason') ?? '')
    .trim()
    .slice(0, 500);
  let statusFlash: 'dismissreason' | 'dismissfailed' | 'reasonnotsaved' | null = null;
  if (reportId && (status === 'open' || status === 'dismissed' || status === 'logged')) {
    if (status === 'dismissed' && !dismissalReason) {
      statusFlash = 'dismissreason';
    } else {
      try {
        await setIncidentReportStatus(supabaseEnv, accessToken, reportId, status, dismissalReason);
      } catch (err) {
        console.error('Failed to update incident report status:', err);
        if (status === 'dismissed') {
          statusFlash = 'dismissfailed';
          // Migration 0111 (the dismissal_reason column) hasn't been run yet: still dismiss
          // the report, and say plainly that the reason couldn't be saved.
          if (err instanceof Error && err.message.includes('dismissal_reason')) {
            try {
              await setIncidentReportStatus(supabaseEnv, accessToken, reportId, status);
              statusFlash = 'reasonnotsaved';
            } catch (retryErr) {
              console.error('Failed to dismiss incident report (without a reason):', retryErr);
            }
          }
        }
      }
    }
  }
  // Back to the top of the reports list (see REPORTS_ANCHOR), not the top of
  // the page, without a ?review= failure left over from an earlier save
  // (or with one for a dismissal that didn't go through).
  const url = new URL(ctx.url);
  url.searchParams.delete('review');
  if (statusFlash) url.searchParams.set('review', statusFlash);
  return ctx.redirect(`${shellPath}${url.search}#${REPORTS_ANCHOR}`);
}
