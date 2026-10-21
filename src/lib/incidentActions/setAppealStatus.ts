import { setIncidentAppealStatus } from '../incidentAppeals';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/** `set-appeal-status` (admin only). */
export async function handleSetAppealStatus(
  ctx: IncidentActionContext,
  form: FormData,
  intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, shellPath } = ctx;
  const appealId = String(form.get('appeal_id') ?? '');
  const status = String(form.get('status') ?? '');
  if (appealId && (status === 'open' || status === 'reviewed' || status === 'dismissed')) {
    try {
      await setIncidentAppealStatus(supabaseEnv, accessToken, appealId, status);
    } catch (err) {
      console.error('Failed to update incident appeal status:', err);
    }
  }
  return ctx.redirect(`${shellPath}${ctx.url.search}`);
}
