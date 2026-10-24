import { restGet, type SupabaseEnv } from '../db/client';
import {
  getAppealClosesAt,
  getPenaltySubsession,
  isAppealOpen,
  createIncidentAppeal,
  uploadAppealFile,
  safeAppealFileName,
  APPEAL_MAX_FILES,
  APPEAL_MAX_FILE_BYTES,
  APPEAL_MAX_FILE_MB,
  APPEAL_MAX_MESSAGE_LENGTH,
  APPEAL_ALLOWED_MIME_TYPES,
  type AppealFileMeta,
} from '../incidentAppeals';
import { canAppealPenalty } from '../incidents';
import { parseDbErrorCode } from '../incidentErrors';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * What an appeal attempt ended as. The round page puts it in its ?appeal= redirect; the profile turns it into
 * C4's JSON message.
 */
export type AppealOutcome =
  'ok' | 'closed' | 'notinvolved' | 'already' | 'unknown' | 'invalid' | 'toomany' | 'toolarge' | 'badtype' | 'failed';

export interface AppealCoreInput {
  penaltyId: string;
  message: string;
  files: File[];
}

export interface AppealSession {
  accessToken: string;
  user: { id: string };
}

/** Database refusals ('<CODE>: ...' or a can_appeal_penalty result) as outcomes; anything else is null. */
function outcomeForCode(code: string | null): AppealOutcome | null {
  if (code === 'CLOSED') return 'closed';
  if (code === 'NOT_INVOLVED') return 'notinvolved';
  if (code === 'ALREADY_APPEALED') return 'already';
  if (code === 'UNKNOWN') return 'unknown';
  return null;
}

/** The form's appeal fields, checked the same way on both pages; null when they pass. */
export function appealInputProblem(input: AppealCoreInput): AppealOutcome | null {
  if (
    !/^[0-9a-f-]{36}$/i.test(input.penaltyId) ||
    !input.message ||
    input.message.length > APPEAL_MAX_MESSAGE_LENGTH
  )
    return 'invalid';
  if (input.files.length > APPEAL_MAX_FILES) return 'toomany';
  if (input.files.some((f) => f.size > APPEAL_MAX_FILE_BYTES)) return 'toolarge';
  if (input.files.some((f) => !APPEAL_ALLOWED_MIME_TYPES.includes(f.type))) return 'badtype';
  return null;
}

/** The attached files from a posted form, skipping the empty entry a file box sends when nothing is picked. */
export function appealFilesFrom(form: { getAll(name: string): unknown[] }): File[] {
  return form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
}

/**
 * The shared appeal: checks the fields, asks can_appeal_penalty before uploading anything (so a refused
 * appeal leaves no files), uploads into the user's own folder, then records it with one SECURITY DEFINER
 * call, which repeats every check (0093, 0113, 20261101120000). Logs carry the outcome and penalty id only.
 */
export async function submitAppealCore(
  env: SupabaseEnv,
  session: AppealSession,
  input: AppealCoreInput,
): Promise<AppealOutcome> {
  const problem = appealInputProblem(input);
  if (problem) return problem;
  const token = session.accessToken;
  try {
    const allowed = outcomeForCode(await canAppealPenalty(env, token, input.penaltyId));
    if (allowed) {
      console.warn('submit-appeal refused', allowed, input.penaltyId);
      return allowed;
    }
    const appealId = crypto.randomUUID();
    const uploaded: AppealFileMeta[] = [];
    for (const [i, file] of input.files.entries()) {
      const path = `${session.user.id}/${appealId}/${i + 1}-${safeAppealFileName(file.name)}`;
      await uploadAppealFile(env, token, path, file);
      uploaded.push({ path, name: file.name, size: file.size, type: file.type });
    }
    await createIncidentAppeal(env, token, {
      id: appealId,
      penalty_id: input.penaltyId,
      message: input.message,
      files: uploaded,
    });
    return 'ok';
  } catch (err) {
    const outcome = outcomeForCode(parseDbErrorCode(err)) ?? 'failed';
    console.error('submit-appeal failed', outcome, input.penaltyId);
    return outcome;
  }
}

/** The user-facing message for an outcome, shared by the round page's flash and the profile's popup. */
export function appealOutcomeMessage(outcome: AppealOutcome): string {
  switch (outcome) {
    case 'ok':
      return 'Appeal submitted. The stewards will review it.';
    case 'closed':
      return 'The appeal window for this round has closed.';
    case 'notinvolved':
      return "You're not involved in this incident.";
    case 'already':
      return "You've already appealed this incident.";
    case 'unknown':
      return 'That incident could not be found.';
    case 'invalid':
      return 'Your appeal needs a written explanation.';
    case 'toomany':
      return `You can attach up to ${APPEAL_MAX_FILES} files.`;
    case 'toolarge':
      return `Each file must be ${APPEAL_MAX_FILE_MB} MB or smaller.`;
    case 'badtype':
      return 'Attachments must be images, PDFs, videos (MP4/WebM/MOV) or text files.';
    default:
      return "Couldn't save your appeal right now. Please try again.";
  }
}

/**
 * `submit-appeal` on the round page, any signed-in user, only while the Incident Appeal Window is open
 * (checked here and in the database); the database also refuses accounts not involved in the incident and a
 * second appeal. Answers with a redirect carrying ?appeal=<outcome>.
 */
export async function handleSubmitAppeal(
  ctx: Omit<IncidentActionContext, 'accessToken' | 'actor' | 'roundLabel'>,
  postForm: FormData,
): Promise<IncidentActionRedirect> {
  const { supabaseEnv, subsessionId, shellPath } = ctx;
  const back = (code: string) => {
    const url = new URL(ctx.url);
    url.searchParams.set('appeal', code);
    return ctx.redirect(`${shellPath}${url.search}`);
  };
  // Honeypot — real users never fill this hidden field.
  if (String(postForm.get('website') ?? '').trim() !== '') return back('ok');
  const appealSession = ctx.session;
  if (!appealSession) return back('signin');
  const appealCloses = await getAppealClosesAt(supabaseEnv, subsessionId);
  if (!isAppealOpen(appealCloses)) return back('closed');

  const input: AppealCoreInput = {
    penaltyId: String(postForm.get('penalty_id') ?? ''),
    message: String(postForm.get('message') ?? '').trim(),
    files: appealFilesFrom(postForm),
  };
  const problem = appealInputProblem(input);
  if (problem) return back(problem);

  try {
    const owned = await restGet<{ id: string }[]>(
      supabaseEnv,
      `penalties_shown?select=id&id=eq.${input.penaltyId}&subsession_id=eq.${subsessionId}`,
    );
    if (owned.length === 0) return back('unknown');
  } catch {
    console.error('submit-appeal failed', 'failed', input.penaltyId);
    return back('failed');
  }
  return back(await submitAppealCore(supabaseEnv, appealSession, input));
}

/** C4's answer to the profile's `submit-appeal-from-profile`, plus the outcome for the no-JavaScript redirect. */
export interface ProfileAppealResult {
  outcome: AppealOutcome;
  ok: boolean;
  message: string;
  data?: { id: string; state: 'appealed' };
}

/**
 * `submit-appeal-from-profile`: the owner appeals one of their own penalties from the Incident Management tab.
 * The penalty's round comes from penalties_shown (an unposted or unknown penalty is refused as invalid), then
 * the shared core runs.
 */
export async function handleProfileAppeal(
  env: SupabaseEnv,
  session: AppealSession,
  form: { get(name: string): unknown; getAll(name: string): unknown[] },
): Promise<ProfileAppealResult> {
  const input: AppealCoreInput = {
    penaltyId: String(form.get('penalty_id') ?? ''),
    message: String(form.get('message') ?? '').trim(),
    files: appealFilesFrom(form),
  };
  let outcome = appealInputProblem(input);
  if (!outcome) {
    try {
      const subsessionId = await getPenaltySubsession(env, input.penaltyId);
      outcome = subsessionId === null ? 'unknown' : await submitAppealCore(env, session, input);
    } catch {
      outcome = 'failed';
    }
  }
  if (outcome !== 'ok') console.error('submit-appeal-from-profile failed', outcome, input.penaltyId);
  return {
    outcome,
    ok: outcome === 'ok',
    message: appealOutcomeMessage(outcome),
    ...(outcome === 'ok' ? { data: { id: input.penaltyId, state: 'appealed' as const } } : {}),
  };
}
