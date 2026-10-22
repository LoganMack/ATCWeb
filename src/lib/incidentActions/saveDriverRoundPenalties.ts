import { strOrNullField } from '../penaltyActions';
import {
  getRoundPenaltiesForDriver,
  createRoundPenalty,
  updateRoundPenalty,
  deleteRoundPenalty,
  isRoundPenaltyKind,
  ROUND_PENALTY_KINDS,
  ROUND_PENALTY_NOTE_MAX_LENGTH,
} from '../roundPenalties';
import { logActivity } from '../activityLog';
import { ROUND_SUMMARY_ANCHOR } from './anchors';
import { roundPenaltyBack } from './shared';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `save-driver-round-penalties` (admin only), the Round Summary row's Edit. Ticked kinds are added, unticked
 * ones removed, served ones too: this popup is the one place a penalty is waived. Separate writes, not a
 * transaction: on a partial failure the earlier writes stay, are logged, and the flash says to check.
 */
export async function handleSaveDriverRoundPenalties(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel, subsessionId } = ctx;
  const driverId = String(form.get('driver_id') ?? '');
  const wanted = new Set(form.getAll('kinds').map(String).filter(isRoundPenaltyKind));
  const otherNote = strOrNullField(form, 'other_note')?.slice(0, ROUND_PENALTY_NOTE_MAX_LENGTH) ?? null;
  let changes = 0;
  let failed = false;
  if (driverId) {
    try {
      const existing = await getRoundPenaltiesForDriver(supabaseEnv, subsessionId, driverId);
      for (const kind of ROUND_PENALTY_KINDS) {
        if (kind === 'other') continue;
        const logged = existing.filter((rp) => rp.kind === kind);
        if (wanted.has(kind) && logged.length === 0) {
          await createRoundPenalty(supabaseEnv, accessToken, {
            subsession_id: subsessionId,
            driver_id: driverId,
            kind,
            note: null,
            created_by: actor.id,
          });
          changes++;
        } else if (!wanted.has(kind)) {
          for (const rp of logged) {
            await deleteRoundPenalty(supabaseEnv, accessToken, rp.id);
            changes++;
          }
        }
      }
      // Only the first Other is edited here; any more stay in the Round Penalties table.
      const other = existing.find((rp) => rp.kind === 'other');
      if (otherNote && !other) {
        await createRoundPenalty(supabaseEnv, accessToken, {
          subsession_id: subsessionId,
          driver_id: driverId,
          kind: 'other',
          note: otherNote,
          created_by: actor.id,
        });
        changes++;
      } else if (otherNote && other && other.note !== otherNote) {
        await updateRoundPenalty(supabaseEnv, accessToken, other.id, {
          driver_id: driverId,
          kind: 'other',
          note: otherNote,
          markOwed: false,
        });
        changes++;
      } else if (!otherNote && other) {
        await deleteRoundPenalty(supabaseEnv, accessToken, other.id);
        changes++;
      }
    } catch (err) {
      console.error('Failed to save driver round penalties:', err);
      failed = true;
    }
    if (changes > 0) {
      try {
        await logActivity(supabaseEnv, accessToken, actor, {
          action: 'edit',
          entity_type: 'incident',
          entity_label: `${roundLabel} — round penalties${failed ? ' (partly saved)' : ''}`,
          entity_id: null,
        });
      } catch (err) {
        console.error('Failed to log driver round penalties:', err);
      }
    }
  }
  return roundPenaltyBack(ctx, ROUND_SUMMARY_ANCHOR, failed);
}
