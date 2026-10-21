import { saveIncidentReportReview, REVIEW_PENALTIES } from '../incidentReports';
import { logActivity } from '../activityLog';
import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `save-review` (admin only): a steward's review of a driver-submitted report (0096). The database
 * enforces admin-only, one review per admin, and the lock once logged.
 */
export async function handleSaveReview(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, shellPath } = ctx;
  const reportId = String(form.get('report_id') ?? '');
  const explanation = String(form.get('explanation') ?? '').trim();
  // Every ticked car with its own suggested penalty ("penalty:<driver id>",
  // src/scripts/faultCards.ts), or explicitly Racing Incident with none (0100).
  const racingIncident = form.get('racing_incident') === 'on';
  const faultDriverIds = [...new Set(form.getAll('fault_driver_ids').map(String).filter(Boolean))];
  const faults = faultDriverIds.map((driver_id) => ({
    driver_id,
    penalty: REVIEW_PENALTIES.find((p) => p === String(form.get(`penalty:${driver_id}`) ?? '')),
  }));
  // ?review=<code> drives the message above the reports (reviewFlash below);
  // a successful save clears any code left over from an earlier failure.
  const back = (code: 'locked' | 'involved' | 'invalid' | 'failed' | null) => {
    const url = new URL(ctx.url);
    if (code) url.searchParams.set('review', code);
    else url.searchParams.delete('review');
    return ctx.redirect(`${shellPath}${url.search}#${REPORTS_ANCHOR}`);
  };
  const validFaults = racingIncident ? faults.length === 0 : faults.length > 0 && faults.every((f) => f.penalty);
  if (!reportId || !validFaults || !explanation) return back('invalid');
  try {
    await saveIncidentReportReview(supabaseEnv, accessToken, {
      report_id: reportId,
      faults: faults.map((f) => ({ driver_id: f.driver_id, penalty: f.penalty! })),
      explanation,
    });
  } catch (err) {
    console.error('Failed to save incident report review:', err);
    // Expected when another admin logs the report mid-review — see 0096's save function —
    // or when the steward was one of the report's drivers (0099).
    const message = err instanceof Error ? err.message : '';
    return back(message.includes('reviews are locked') ? 'locked' : message.includes('involved in this incident') ? 'involved' : 'failed');
  }
  // No verdict in the log entry — that would undo the blind voting.
  await logActivity(supabaseEnv, accessToken, actor, {
    action: 'edit',
    entity_type: 'incident_report',
    entity_label: `${roundLabel} — steward review`,
    entity_id: reportId,
  });
  return back(null);
}
