import { logActivity } from '../activityLog';
import { incidentReportBlocked } from '../incidentPageHeader';
import { postingLogLabel, setRoundPosted } from '../incidentReports';
import { getRoundBySubsessionId } from '../results/rounds';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `post-report` (Admin or Staff): posts the round's incident report from the page's Post Report button, which
 * sends the website and email notifications. The database function checks the caller; the post date is kept
 * if the round was posted before. The submission window is checked again here, because the page's disabled
 * button can be stale or bypassed: ?post=open while it is open, ?post=failed on any failure.
 */
export async function handlePostReport(ctx: IncidentActionContext): Promise<IncidentActionRedirect> {
  const url = new URL(ctx.url);
  url.searchParams.delete('post');
  const back = (flash: 'open' | 'failed' | null) => {
    if (flash) url.searchParams.set('post', flash);
    return ctx.redirect(`${ctx.shellPath}${url.search}`);
  };

  let trackName = String(ctx.subsessionId);
  try {
    const round = await getRoundBySubsessionId(ctx.supabaseEnv, ctx.subsessionId);
    if (!round) return back('failed');
    trackName = round.track_name;
    if (await incidentReportBlocked(ctx.supabaseEnv, ctx.subsessionId, round.start_time)) return back('open');
    const result = await setRoundPosted(ctx.supabaseEnv, ctx.accessToken, ctx.subsessionId, {
      posted: true,
      resetDate: false,
    });
    // The log line is best effort: the round is already posted, so a failed write must not report a failure.
    try {
      await logActivity(ctx.supabaseEnv, ctx.accessToken, ctx.actor, {
        action: 'edit',
        entity_type: 'incident_report',
        entity_label: postingLogLabel(true, !result.firstPost, 'keep', trackName),
        entity_id: String(ctx.subsessionId),
      });
    } catch (err) {
      console.error('Failed to log the incident report post:', err);
    }
  } catch (err) {
    console.error('Failed to post the incident report:', err);
    return back('failed');
  }
  return back(null);
}
