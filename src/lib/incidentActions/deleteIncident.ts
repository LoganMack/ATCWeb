import { deletePenalty } from '../db/penalties';
import { recomputeDriverSeasonPP } from '../penaltyActions';
import { logActivity } from '../activityLog';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** `delete-incident` (admin only). */
export async function handleDeleteIncident(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, shellPath } = ctx;
  const penaltyId = String(form.get('penalty_id') ?? '');
  const driverId = String(form.get('driver_id') ?? '');
  try {
    if (penaltyId) {
      await deletePenalty(supabaseEnv, accessToken, penaltyId);
      await logActivity(supabaseEnv, accessToken, actor, {
        action: 'delete',
        entity_type: 'incident',
        entity_label: roundLabel,
        entity_id: penaltyId,
      });
    }
    if (driverId) await recomputeDriverSeasonPP(supabaseEnv, accessToken, driverId);
  } catch (err) {
    console.error('Failed to delete incident:', err);
  }
  return ctx.redirect(`${shellPath}${ctx.url.search}`);
}
