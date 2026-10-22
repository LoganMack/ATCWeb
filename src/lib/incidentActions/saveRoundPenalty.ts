import { strOrNullField } from '../penaltyActions';
import {
  createRoundPenalty,
  updateRoundPenalty,
  isRoundPenaltyKind,
  ROUND_PENALTY_LABELS,
  ROUND_PENALTY_NOTE_MAX_LENGTH,
} from '../roundPenalties';
import { logActivity } from '../activityLog';
import { ROUND_SUMMARY_ANCHOR } from './anchors';
import { roundPenaltyBack } from './shared';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `add-round-penalty` and `update-round-penalty` (admin only; 0104_round_penalties.sql): log one
 * against a driver for this round, or edit one.
 */
export async function handleSaveRoundPenalty(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, subsessionId } = ctx;
  const driverId = String(form.get('driver_id') ?? '');
  const kind = String(form.get('kind') ?? '');
  const note = strOrNullField(form, 'note')?.slice(0, ROUND_PENALTY_NOTE_MAX_LENGTH) ?? null;
  const id = String(form.get('round_penalty_id') ?? '');
  let failed = false;
  if (
    driverId &&
    isRoundPenaltyKind(kind) &&
    (kind !== 'other' || note) &&
    (intent === 'add-round-penalty' || id)
  ) {
    try {
      if (intent === 'add-round-penalty') {
        await createRoundPenalty(supabaseEnv, accessToken, {
          subsession_id: subsessionId,
          driver_id: driverId,
          kind,
          note,
          created_by: actor.id,
        });
      } else {
        await updateRoundPenalty(supabaseEnv, accessToken, id, {
          driver_id: driverId,
          kind,
          note,
          markOwed: form.get('status') === 'owed',
        });
      }
      await logActivity(supabaseEnv, accessToken, actor, {
        action: intent === 'add-round-penalty' ? 'add' : 'edit',
        entity_type: 'incident',
        entity_label: `${roundLabel} — round penalty (${ROUND_PENALTY_LABELS[kind]})`,
        entity_id: null,
      });
    } catch (err) {
      console.error('Failed to save round penalty:', err);
      failed = true;
    }
  }
  return roundPenaltyBack(ctx, ROUND_SUMMARY_ANCHOR, failed);
}
