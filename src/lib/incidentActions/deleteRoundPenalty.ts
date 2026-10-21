import { deleteRoundPenalty } from '../roundPenalties';
import { logActivity } from '../activityLog';
import { ROUND_SUMMARY_ANCHOR } from './anchors';
import { roundPenaltyBack } from './shared';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** `delete-round-penalty` (admin only). */
export async function handleDeleteRoundPenalty(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel } = ctx;
  const id = String(form.get('round_penalty_id') ?? '');
  let failed = false;
  if (id) {
    try {
      await deleteRoundPenalty(supabaseEnv, accessToken, id);
      await logActivity(supabaseEnv, accessToken, actor, {
        action: 'delete',
        entity_type: 'incident',
        entity_label: `${roundLabel} — round penalty`,
        entity_id: null,
      });
    } catch (err) {
      console.error('Failed to delete round penalty:', err);
      failed = true;
    }
  }
  return roundPenaltyBack(ctx, ROUND_SUMMARY_ANCHOR, failed);
}
