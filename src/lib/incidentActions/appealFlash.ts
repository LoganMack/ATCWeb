import { REPORTS_ANCHOR } from './anchors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * How a steward's appeal action went (?appealaction=), shown above the reported incidents. A separate
 * parameter from ?appeal=, which already carries the driver's own Submit Appeal outcome (and its own
 * `invalid`).
 */
export type AppealActionFlash =
  | 'closed-ok'
  | 'comment-ok'
  | 'already-closed'
  | 'dismissed'
  | 'not-allowed'
  | 'invalid'
  | 'failed';

export const APPEAL_ACTION_FLASH_MESSAGES: Record<AppealActionFlash, { kind: 'ok' | 'error'; message: string }> = {
  'closed-ok': { kind: 'ok', message: 'Appeal closed. The penalty now shows your decision.' },
  'comment-ok': { kind: 'ok', message: 'Comment saved.' },
  'already-closed': { kind: 'error', message: 'This appeal is no longer open, so nothing was changed.' },
  dismissed: {
    kind: 'error',
    message: 'This appeal was dismissed, so it was not closed. Reopen it first to decide it.',
  },
  'not-allowed': {
    kind: 'error',
    message: 'You are involved in this incident, so another steward must decide the appeal.',
  },
  invalid: {
    kind: 'error',
    message: 'Check the values: whole numbers of 0 or more, a time with at most 3 decimals, and a comment of 1 to 4,000 characters.',
  },
  failed: { kind: 'error', message: "Couldn't save that right now. Please try again." },
};

/** Back to the reported incidents with this outcome, replacing any earlier one. */
export function appealActionRedirect(ctx: IncidentActionContext, code: AppealActionFlash): IncidentActionRedirect {
  const url = new URL(ctx.url);
  url.searchParams.set('appealaction', code);
  return ctx.redirect(`${ctx.shellPath}${url.search}#${REPORTS_ANCHOR}`);
}
