import type { SupabaseEnv } from '../db/client';
import { addMyIncidentComment, INCIDENT_COMMENT_MAX_LENGTH, type IncidentActionCode } from '../incidents';
import {
  appealOutcomeMessage,
  handleProfileAppeal,
  type AppealOutcome,
  type AppealSession,
} from './submitAppeal';

/**
 * The Incident Management tab's two in-place intents on the own profile (U5, contract C4). Owner-only: the
 * profile controller (src/lib/driverAccount.ts handleProfilePost) calls these only after its owner check. The
 * report and penalty ids come from the form and are never trusted: the database decides.
 */
export const INCIDENT_PROFILE_INTENTS = ['add-incident-comment', 'submit-appeal-from-profile'] as const;
export type IncidentProfileIntent = (typeof INCIDENT_PROFILE_INTENTS)[number];

/** The status query a no-JavaScript post redirects with (codes only, never text). */
export const INCIDENT_STATUS_PARAM = 'incident_status';

export interface IncidentIntentResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  /** HTTP status for the JSON answer. */
  status: number;
  /** The code for the redirect's status query. */
  code: string;
}

export function commentErrorMessage(code: IncidentActionCode): string {
  switch (code) {
    case 'NOT_INVOLVED':
      return "You're not involved in this incident.";
    case 'CLOSED':
      return 'This incident is no longer open for comments.';
    case 'ALREADY_COMMENTED':
      return "You've already commented.";
    case 'INVALID':
      return `Write a comment of 1 to ${INCIDENT_COMMENT_MAX_LENGTH.toLocaleString('en-US')} characters.`;
    default:
      return "Couldn't send your comment. Try again.";
  }
}

export const COMMENT_SENT_MESSAGE = 'Comment sent. Only the stewards can see it.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleProfileComment(
  env: SupabaseEnv,
  session: AppealSession,
  form: { get(name: string): unknown },
): Promise<IncidentIntentResult> {
  const reportId = String(form.get('report_id') ?? '');
  const body = String(form.get('body') ?? '').trim();
  let outcome: { ok: true } | { ok: false; code: IncidentActionCode };
  if (!UUID.test(reportId)) outcome = { ok: false, code: 'NOT_INVOLVED' };
  else if (body.length < 1 || body.length > INCIDENT_COMMENT_MAX_LENGTH)
    outcome = { ok: false, code: 'INVALID' };
  else outcome = await addMyIncidentComment(env, session.accessToken, reportId, body);

  if (outcome.ok) {
    return {
      ok: true,
      message: COMMENT_SENT_MESSAGE,
      data: { id: reportId, state: 'pending', commentSent: true },
      status: 200,
      code: 'comment_sent',
    };
  }
  // Codes and ids only: never the comment text or a name (NFR9.1).
  console.error('add-incident-comment failed', outcome.code, reportId);
  const status = outcome.code === 'UNKNOWN' ? 502 : outcome.code === 'INVALID' ? 400 : 409;
  return { ok: false, message: commentErrorMessage(outcome.code), status, code: `comment_${outcome.code}` };
}

function appealStatus(outcome: AppealOutcome): number {
  if (outcome === 'ok') return 200;
  if (outcome === 'failed') return 502;
  if (outcome === 'notinvolved' || outcome === 'already' || outcome === 'closed') return 409;
  return 400;
}

/** Runs one of the tab's intents for the signed-in owner. */
export async function handleIncidentProfileIntent(
  intent: IncidentProfileIntent,
  env: SupabaseEnv,
  session: AppealSession,
  form: { get(name: string): unknown; getAll(name: string): unknown[] },
): Promise<IncidentIntentResult> {
  if (intent === 'add-incident-comment') return handleProfileComment(env, session, form);
  const appeal = await handleProfileAppeal(env, session, form);
  return {
    ok: appeal.ok,
    message: appeal.message,
    ...(appeal.data ? { data: appeal.data } : {}),
    status: appealStatus(appeal.outcome),
    code: `appeal_${appeal.outcome}`,
  };
}

/** The message for a no-JavaScript redirect's status code, or null for none or an unknown one. */
export function incidentStatusMessage(code: string | null): { ok: boolean; message: string } | null {
  if (!code) return null;
  if (code === 'comment_sent') return { ok: true, message: COMMENT_SENT_MESSAGE };
  const comment = /^comment_(NOT_INVOLVED|CLOSED|ALREADY_COMMENTED|INVALID|UNKNOWN)$/.exec(code);
  if (comment) return { ok: false, message: commentErrorMessage(comment[1] as IncidentActionCode) };
  const appeal = /^appeal_(ok|closed|notinvolved|already|unknown|invalid|toomany|toolarge|badtype|failed)$/.exec(
    code,
  );
  if (appeal) {
    const outcome = appeal[1] as AppealOutcome;
    return { ok: outcome === 'ok', message: appealOutcomeMessage(outcome) };
  }
  return null;
}
