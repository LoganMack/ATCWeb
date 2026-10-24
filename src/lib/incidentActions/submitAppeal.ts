import { restGet } from '../db/client';
import {
  getAppealClosesAt,
  isAppealOpen,
  createIncidentAppeal,
  uploadAppealFile,
  safeAppealFileName,
  APPEAL_MAX_FILES,
  APPEAL_MAX_FILE_BYTES,
  APPEAL_MAX_MESSAGE_LENGTH,
  APPEAL_ALLOWED_MIME_TYPES,
  type AppealFileMeta,
} from '../incidentAppeals';
import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * `submit-appeal`, any signed-in user, only while the Incident Appeal Window is open (checked here and in the
 * database). Files go to the user's folder in the private 'incident-appeals' bucket first, then one SECURITY
 * DEFINER call records the appeal (0093, 0113).
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

  const penaltyId = String(postForm.get('penalty_id') ?? '');
  const message = String(postForm.get('message') ?? '').trim();
  const files = postForm.getAll('files').filter((f): f is File => typeof f !== 'string' && f.size > 0);
  if (!/^[0-9a-f-]{36}$/i.test(penaltyId) || !message || message.length > APPEAL_MAX_MESSAGE_LENGTH)
    return back('invalid');
  if (files.length > APPEAL_MAX_FILES) return back('toomany');
  if (files.some((f) => f.size > APPEAL_MAX_FILE_BYTES)) return back('toolarge');
  if (files.some((f) => !APPEAL_ALLOWED_MIME_TYPES.includes(f.type))) return back('badtype');

  try {
    const owned = await restGet<{ id: string }[]>(
      supabaseEnv,
      `penalties_shown?select=id&id=eq.${penaltyId}&subsession_id=eq.${subsessionId}`,
    );
    if (owned.length === 0) return back('invalid');
    const appealId = crypto.randomUUID();
    const token = appealSession.accessToken;
    const uploaded: AppealFileMeta[] = [];
    for (const [i, file] of files.entries()) {
      const path = `${appealSession.user.id}/${appealId}/${i + 1}-${safeAppealFileName(file.name)}`;
      await uploadAppealFile(supabaseEnv, token, path, file);
      uploaded.push({ path, name: file.name, size: file.size, type: file.type });
    }
    await createIncidentAppeal(supabaseEnv, token, {
      id: appealId,
      penalty_id: penaltyId,
      message,
      files: uploaded,
    });
  } catch (err) {
    console.error('Failed to save incident appeal:', err);
    return back('failed');
  }
  return back('ok');
}
