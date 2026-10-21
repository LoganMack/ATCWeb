import { setRoundPenaltyServed } from '../roundPenalties';
import { logActivity } from '../activityLog';
import { OWED_PENALTIES_ANCHOR } from './anchors';
import { roundPenaltyBack } from './shared';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `set-round-penalty-served` (admin only): mark a round penalty (from this or an earlier round)
 * served at this round, or owed again.
 */
export async function handleSetRoundPenaltyServed(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, subsessionId } = ctx;
  const id = String(form.get('round_penalty_id') ?? '');
  const served = form.get('served') === '1';
  let failed = false;
  if (id) {
    try {
      await setRoundPenaltyServed(supabaseEnv, accessToken, id, served ? subsessionId : null);
      await logActivity(supabaseEnv, accessToken, actor, {
        action: 'edit',
        entity_type: 'incident',
        entity_label: `${roundLabel} — round penalty ${served ? 'served' : 'marked owed'}`,
        entity_id: null,
      });
    } catch (err) {
      console.error('Failed to update round penalty:', err);
      failed = true;
    }
  }
  return roundPenaltyBack(ctx, OWED_PENALTIES_ANCHOR, failed);
}
