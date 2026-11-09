import { closeIncidentAppeal, type CloseAppealOutcome } from '../incidentAppeals';
import { parseCloseAppealForm } from '../appealClose';
import { logActivity } from '../activityLog';
import { appealActionRedirect, type AppealActionFlash } from './appealFlash';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

const FLASH_BY_OUTCOME: Record<CloseAppealOutcome, AppealActionFlash> = {
  ok: 'closed-ok',
  already_closed: 'already-closed',
  not_open: 'dismissed',
  not_allowed: 'not-allowed',
  invalid: 'invalid',
};

/**
 * `close-appeal` (admin only, BR3.1-BR3.3): checks the form, then close_incident_appeal decides who may close
 * and writes the decision to the appeal and its penalty in one transaction.
 */
export async function handleCloseAppeal(
  ctx: IncidentActionContext,
  form: FormData,
  _intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, actor, roundLabel } = ctx;
  const parsed = parseCloseAppealForm(form);
  if (!parsed.ok) return appealActionRedirect(ctx, 'invalid');
  let outcome: CloseAppealOutcome;
  try {
    outcome = await closeIncidentAppeal(supabaseEnv, accessToken, parsed.appealId, parsed.input);
  } catch (err) {
    console.error('Failed to close incident appeal:', err);
    return appealActionRedirect(ctx, 'failed');
  }
  if (outcome === 'ok') {
    await logActivity(supabaseEnv, accessToken, actor, {
      action: 'edit',
      entity_type: 'incident_appeal',
      entity_label: `${roundLabel} — appeal closed`,
      entity_id: parsed.appealId,
    });
  }
  return appealActionRedirect(ctx, FLASH_BY_OUTCOME[outcome]);
}
