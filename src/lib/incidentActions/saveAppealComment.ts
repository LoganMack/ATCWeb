import { saveIncidentAppealComment, type AppealCommentOutcome } from '../incidentAppeals';
import { parseAppealCommentBody, parseAppealId } from '../appealClose';
import { logActivity } from '../activityLog';
import { appealActionRedirect, type AppealActionFlash } from './appealFlash';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

const FLASH_BY_OUTCOME: Record<AppealCommentOutcome, AppealActionFlash> = {
  ok: 'comment-ok',
  not_open: 'already-closed',
  not_allowed: 'not-allowed',
  invalid: 'invalid',
};

/**
 * `save-appeal-comment` (admin only, BR2.1-BR2.3): adds or replaces the steward's own comment on an open
 * appeal. The comment text stays out of the activity log, since comments are internal (BR2.4).
 */
export async function handleSaveAppealComment(
  ctx: IncidentActionContext,
  form: FormData,
  _intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel } = ctx;
  const appealId = parseAppealId(form);
  const body = parseAppealCommentBody(form);
  if (!appealId || !body.ok) return appealActionRedirect(ctx, 'invalid');
  let outcome: AppealCommentOutcome;
  try {
    outcome = await saveIncidentAppealComment(supabaseEnv, accessToken, appealId, body.body);
  } catch (err) {
    console.error('Failed to save appeal comment:', err);
    return appealActionRedirect(ctx, 'failed');
  }
  if (outcome === 'ok') {
    await logActivity(supabaseEnv, accessToken, actor, {
      action: 'edit',
      entity_type: 'incident_appeal',
      entity_label: `${roundLabel} — steward comment on an appeal`,
      entity_id: appealId,
    });
  }
  return appealActionRedirect(ctx, FLASH_BY_OUTCOME[outcome]);
}
