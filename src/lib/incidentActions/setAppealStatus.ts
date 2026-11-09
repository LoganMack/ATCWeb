import { setIncidentAppealStatus } from '../incidentAppeals';
import { appealActionRedirect } from './appealFlash';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `set-appeal-status` (admin only): Dismiss and Reopen only. Reviewed comes only from Close Appeal, so it is
 * ignored here (BR3.6); the database refuses it on every path anyway (BR3.5) and refuses an involved steward
 * (BR3.7).
 */
export async function handleSetAppealStatus(
  ctx: IncidentActionContext,
  form: FormData,
  _intent: string,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, accessToken, shellPath } = ctx;
  const appealId = String(form.get('appeal_id') ?? '');
  const status = String(form.get('status') ?? '');
  if (appealId && (status === 'open' || status === 'dismissed')) {
    try {
      await setIncidentAppealStatus(supabaseEnv, accessToken, appealId, status);
    } catch (err) {
      console.error('Failed to update incident appeal status:', err);
      // The lock trigger's codes (20261115120000_appeal_close_and_comments.sql).
      const message = err instanceof Error ? err.message : '';
      if (message.includes('INVOLVED_STEWARD')) return appealActionRedirect(ctx, 'not-allowed');
      if (message.includes('ALREADY_CLOSED') || message.includes('NOT_OPEN'))
        return appealActionRedirect(ctx, 'already-closed');
      return appealActionRedirect(ctx, 'failed');
    }
  }
  // A message left over from an earlier appeal action would no longer be true.
  const url = new URL(ctx.url);
  url.searchParams.delete('appealaction');
  return ctx.redirect(`${shellPath}${url.search}`);
}
