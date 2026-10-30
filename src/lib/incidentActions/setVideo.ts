import { normalizeClipUrl, type ClipWriteResult } from '../clipLink';
import { setIncidentReportVideo } from '../incidentReports';
import { setIncidentVideo } from '../db/penalties';
import { logActivity } from '../activityLog';
import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** The `?video=` value the page reads back after an Add/Edit Video save. */
export type VideoFlash = 'saved' | 'cleared' | 'invalid' | 'notfound' | 'nonumber' | 'notallowed' | 'failed';

export const VIDEO_FLASH_MESSAGES: Record<VideoFlash, { ok: boolean; message: string }> = {
  saved: { ok: true, message: 'Video saved.' },
  cleared: { ok: true, message: 'Video removed.' },
  invalid: {
    ok: false,
    message: 'Video URL: enter a link starting with http:// or https:// (up to 500 characters).',
  },
  notfound: { ok: false, message: 'That incident no longer exists.' },
  nonumber: { ok: false, message: 'Give the incident a number before adding a clip.' },
  notallowed: { ok: false, message: 'Only an admin or staff member can change a clip.' },
  failed: { ok: false, message: "Couldn't save the clip. Try again." },
};

/** Which flash a clip write's result shows. */
export function videoFlashFor(result: ClipWriteResult, url: string): VideoFlash {
  if (result.ok) return url ? 'saved' : 'cleared';
  switch (result.code) {
    case 'INVALID_URL':
      return 'invalid';
    case 'REPORT_NOT_FOUND':
    case 'INCIDENT_NOT_FOUND':
      return 'notfound';
    case 'INCIDENT_NUMBER_REQUIRED':
      return 'nonumber';
    case 'NOT_ALLOWED':
      return 'notallowed';
    default:
      return 'failed';
  }
}

/**
 * Back to the page with the flash. A refused link also names the dialog to re-open (`video_for`), whose
 * script restores the typed link from its own draft: the link itself never goes into the URL.
 */
function videoBack(
  ctx: IncidentActionContext,
  flash: VideoFlash,
  target: string,
  anchor: string | null,
): IncidentActionRedirect {
  const url = new URL(ctx.url);
  url.searchParams.delete('review');
  url.searchParams.delete('video_for');
  url.searchParams.set('video', flash);
  if (flash === 'invalid') url.searchParams.set('video_for', target);
  return ctx.redirect(`${ctx.shellPath}${url.search}${anchor && flash !== 'invalid' ? `#${anchor}` : ''}`);
}

/** `set-report-video` (Admin or Staff): sets or clears a reported incident's clip, in any report status. */
export async function handleSetReportVideo(
  ctx: IncidentActionContext,
  form: FormData,
): Promise<IncidentActionRedirect> {
  const reportId = String(form.get('report_id') ?? '');
  const target = `report:${reportId}`;
  const check = normalizeClipUrl(form.get('video_url'));
  if (!check.ok) return videoBack(ctx, 'invalid', target, REPORTS_ANCHOR);
  if (!reportId) return videoBack(ctx, 'notfound', target, REPORTS_ANCHOR);

  const result = await setIncidentReportVideo(ctx.supabaseEnv, ctx.accessToken, reportId, check.url);
  if (result.ok) {
    await logActivity(ctx.supabaseEnv, ctx.accessToken, ctx.actor, {
      action: 'edit',
      entity_type: 'incident_report',
      entity_label: `${ctx.roundLabel} — ${check.url ? 'video set on a reported incident' : 'video removed from a reported incident'}`,
      entity_id: reportId,
    });
  }
  return videoBack(ctx, videoFlashFor(result, check.url), target, REPORTS_ANCHOR);
}

/** The incident a clip form names: its session ("race:2", "qualifying:0") and incident number. */
export function readIncidentIdentity(
  form: FormData,
  subsessionId: number,
): {
  subsession_id: number;
  session_type: 'race' | 'qualifying' | 'practice';
  race_number: number;
  incident_number: string;
} | null {
  const [type, num] = String(form.get('session') ?? '').split(':');
  if (type !== 'race' && type !== 'qualifying' && type !== 'practice') return null;
  const raceNumber = type === 'race' ? Number(num) : 0;
  if (!Number.isInteger(raceNumber) || raceNumber < 0) return null;
  return {
    subsession_id: subsessionId,
    session_type: type,
    race_number: raceNumber,
    incident_number: String(form.get('incident_number') ?? '').trim(),
  };
}

/** `set-incident-video` (Admin or Staff): sets or clears the clip on every row of one posted-page incident. */
export async function handleSetIncidentVideo(
  ctx: IncidentActionContext,
  form: FormData,
): Promise<IncidentActionRedirect> {
  const incident = readIncidentIdentity(form, ctx.subsessionId);
  const target = incident
    ? `incident:${incident.session_type}:${incident.race_number}:${incident.incident_number}`
    : '';
  const check = normalizeClipUrl(form.get('video_url'));
  if (!check.ok) return videoBack(ctx, 'invalid', target, null);
  if (!incident) return videoBack(ctx, 'notfound', target, null);
  // An incident without a number can't be told apart from the round's other unnumbered rows.
  if (!incident.incident_number) return videoBack(ctx, 'nonumber', target, null);

  const result = await setIncidentVideo(ctx.supabaseEnv, ctx.accessToken, incident, check.url);
  if (result.ok) {
    const session =
      incident.session_type === 'race'
        ? `Race ${incident.race_number}`
        : incident.session_type === 'qualifying'
          ? 'Qualifying'
          : 'Practice';
    await logActivity(ctx.supabaseEnv, ctx.accessToken, ctx.actor, {
      action: 'edit',
      entity_type: 'incident',
      entity_label: `${ctx.roundLabel} — ${session} #${incident.incident_number}: ${check.url ? 'video set' : 'video removed'}`,
      entity_id: null,
    });
  }
  return videoBack(ctx, videoFlashFor(result, check.url), target, null);
}
