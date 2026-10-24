/**
 * Post-race "media pen" interviews (0109). A driver-linked user records up to INTERVIEW_MAX_SECONDS on the
 * results page; the fragment uploads it to the private 'race-interviews' bucket and records it via
 * submit_race_interview. Admins play them under Admin > Interviews. The uploader lists, downloads and deletes
 * their own on My Profile (20261102120000_interviews_self_service.sql).
 */

import { restGet, restGetAuthed, writeHeaders, type SupabaseEnv } from './db/client';

export const INTERVIEW_BUCKET = 'race-interviews';
export const INTERVIEW_MAX_SECONDS = 60;
/** Interviews can only be submitted for rounds at most this many days old (counted from the round's start; also enforced in submit_race_interview). */
export const INTERVIEW_WINDOW_DAYS = 7;

/** True while the round (by its start time) is still inside the interview window. */
export function isInterviewWindowOpen(roundStartIso: string, now: Date = new Date()): boolean {
  const start = new Date(roundStartIso).getTime();
  return Number.isFinite(start) && now.getTime() - start <= INTERVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
/** Same as the bucket's file_size_limit (0109). 60 s of Opus is ~0.5 MB, so this is generous. */
export const INTERVIEW_MAX_BYTES = 5 * 1024 * 1024;

export interface RaceInterview {
  id: string;
  subsession_id: number;
  driver_id: string;
  audio_path: string;
  audio_type: string;
  duration_seconds: number;
  created_at: string;
  driver: { name: string; car_number: number | null } | null;
}

/** webm / mp4 / ogg from a MediaRecorder mime type ("audio/webm;codecs=opus"), or null when unsupported. */
export function interviewExtension(mimeType: string): 'webm' | 'mp4' | 'ogg' | null {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (base === 'audio/webm' || base === 'video/webm') return 'webm';
  if (base === 'audio/mp4') return 'mp4';
  if (base === 'audio/ogg') return 'ogg';
  return null;
}

/**
 * Object path for a driver's clip for one round: "<driver id>/<subsession id>.<ext>".
 * Storage policies only let a driver write inside their own folder (0114/0115),
 * and the fixed name keeps it to one clip per driver per round.
 */
export function interviewAudioPath(driverId: string, subsessionId: number, ext: string): string {
  return `${driverId}/${subsessionId}.${ext}`;
}

/**
 * Uploads the clip as the signed-in user. x-upsert lets a retry overwrite the
 * same path after a failed record step; storage refuses the overwrite once the
 * clip has been submitted (0114). Throws on failure.
 */
export async function uploadInterviewAudio(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  file: Blob,
  contentType: string,
): Promise<void> {
  const res = await fetch(`${env.url}/storage/v1/object/${INTERVIEW_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) throw new Error(`Interview upload failed (${res.status}): ${await res.text()}`);
}

/** Records the interview (SECURITY DEFINER function, 0109). Throws on failure. */
export async function createRaceInterview(
  env: SupabaseEnv,
  accessToken: string,
  input: {
    id: string;
    subsession_id: number;
    audio_path: string;
    audio_type: string;
    duration_seconds: number;
  },
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_race_interview`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_id: input.id,
      p_subsession_id: input.subsession_id,
      p_audio_path: input.audio_path,
      p_audio_type: input.audio_type,
      p_duration_seconds: input.duration_seconds,
    }),
  });
  if (!res.ok)
    throw new Error(`Supabase rpc error ${res.status} on submit_race_interview: ${await res.text()}`);
}

/** Whether the signed-in user's linked driver already has an interview for this round. False when it can't be checked (e.g. before migration 0109). */
export async function hasSubmittedInterview(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
): Promise<boolean> {
  try {
    const res = await fetch(`${env.url}/rest/v1/rpc/has_submitted_race_interview`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_subsession_id: subsessionId }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

/** Admin read — newest first. */
export async function getRaceInterviews(env: SupabaseEnv, accessToken: string): Promise<RaceInterview[]> {
  return restGetAuthed<RaceInterview[]>(
    env,
    accessToken,
    'race_interviews?select=*,driver:drivers!driver_id(name,car_number)&order=created_at.desc&limit=500',
  );
}

/** Admin: a one-hour playback link (the bucket is private). Null when it can't be signed. */
export async function signInterviewUrl(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${INTERVIEW_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) return null;
    return `${env.url}/storage/v1${body.signedURL.startsWith('/') ? '' : '/'}${body.signedURL}`;
  } catch {
    return null;
  }
}

// --- Deleting audio (BR12.4, BR12.5) ---------------------------------------------------------------

type BulkDeleteResult = { ok: true; removed: boolean } | { ok: false; status: number };

/**
 * Storage's bulk delete for one object, as the token's account. Its answer lists the objects it removed; an
 * empty list means refused or already missing, which only a fresh check can tell apart.
 */
async function bulkDeleteAudio(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
): Promise<BulkDeleteResult> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/${INTERVIEW_BUCKET}`, {
      method: 'DELETE',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const removed = (await res.json().catch(() => null)) as unknown;
    return {
      ok: true,
      removed: Array.isArray(removed) && removed.some((o) => (o as { name?: unknown } | null)?.name === path),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Storage reports a missing object as a 404, or as a 400 whose body carries a not-found code. */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  const text = await res.text().catch(() => '');
  return /"statusCode"\s*:\s*"?404|not_found|not found/i.test(text);
}

/** Admin: true once the object is gone. Throws on any other answer, so the record is kept. */
async function adminAudioIsGone(env: SupabaseEnv, accessToken: string, path: string): Promise<boolean> {
  const res = await fetch(`${env.url}/storage/v1/object/info/${INTERVIEW_BUCKET}/${path}`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) return false;
  if (await isNotFound(res)) return true;
  throw new Error(`Interview audio check failed (${res.status})`);
}

/** Admin: removes the audio file, then the row; an already-missing file counts as removed. Throws on failure. */
export async function deleteRaceInterview(
  env: SupabaseEnv,
  accessToken: string,
  interview: Pick<RaceInterview, 'id' | 'audio_path'>,
): Promise<void> {
  const deleted = await bulkDeleteAudio(env, accessToken, interview.audio_path);
  if (!deleted.ok) throw new Error(`Interview audio delete failed (${deleted.status})`);
  if (!deleted.removed && !(await adminAudioIsGone(env, accessToken, interview.audio_path))) {
    throw new Error('Interview audio delete was refused, so the record was kept');
  }
  const res = await fetch(`${env.url}/rest/v1/race_interviews?id=eq.${encodeURIComponent(interview.id)}`, {
    method: 'DELETE',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status} on race_interviews: ${await res.text()}`);
}

// --- The own profile's Interviews tab (U6; BR12.1-BR12.8; contract C4) ------------------------------

/** The signed-in uploader. Rows are filtered by submitter too, so an admin's own tab lists only theirs. */
export interface InterviewOwner {
  accessToken: string;
  userId: string;
}

export const MY_INTERVIEWS_LIMIT = 200;

/** A row in the Interviews tab. */
export interface MyInterviewRow {
  id: string;
  subsessionId: number;
  roundLabel: string;
  roundHref: string;
  createdAt: string;
  durationSeconds: number;
  /** Whether a new recording is still possible after a delete; null when the round couldn't be read. */
  windowOpen: boolean | null;
}

interface InterviewDbRow {
  id: string;
  subsession_id: number;
  audio_path: string;
  audio_type: string;
  duration_seconds: number;
  created_at: string;
}

export interface InterviewRound {
  subsession_id: number;
  season_label: string | null;
  round_number: number | null;
  track_name: string | null;
  start_time: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "ATC 18 · Round 3 · Spa", or "Round <subsession id>" when the round is unknown. */
export function interviewRoundLabel(subsessionId: number, round: InterviewRound | undefined): string {
  const parts = [
    round?.season_label?.trim(),
    round?.round_number != null ? `Round ${round.round_number}` : '',
    round?.track_name?.trim(),
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : `Round ${subsessionId}`;
}

/** "interview-atc-18-round-3.webm": only [a-z0-9-] before the extension (NFR1.7). */
export function interviewDownloadName(
  row: { subsession_id: number; audio_path: string; audio_type: string },
  round: InterviewRound | undefined,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const pathExt = /\.(webm|mp4|ogg)$/i.exec(row.audio_path)?.[1].toLowerCase();
  const ext = pathExt ?? interviewExtension(row.audio_type) ?? 'webm';
  const parts =
    round?.round_number != null
      ? [round.season_label ? slug(round.season_label) : '', `round-${round.round_number}`]
      : [String(row.subsession_id)];
  const base = ['interview', ...parts].filter(Boolean).join('-');
  return `${slug(base) || 'interview'}.${ext}`;
}

function interviewRow(row: InterviewDbRow, round: InterviewRound | undefined, now: Date): MyInterviewRow {
  return {
    id: row.id,
    subsessionId: row.subsession_id,
    roundLabel: interviewRoundLabel(row.subsession_id, round),
    roundHref: `/results/${row.subsession_id}`,
    createdAt: row.created_at,
    durationSeconds: row.duration_seconds,
    windowOpen: round?.start_time ? isInterviewWindowOpen(round.start_time, now) : null,
  };
}

/** The rounds' labels, one public read; an empty list needs no call. */
async function getInterviewRounds(env: SupabaseEnv, ids: number[]): Promise<Map<number, InterviewRound>> {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id));
  if (unique.length === 0) return new Map();
  const rounds = await restGet<InterviewRound[]>(
    env,
    `curated_rounds?select=subsession_id,season_label,round_number,track_name,start_time&subsession_id=in.(${unique.join(',')})`,
  );
  return new Map(rounds.map((r) => [r.subsession_id, r]));
}

/** The owner's interviews, newest first, at most 200, read with their token under RLS. Throws on failure. */
export async function getMyInterviews(
  env: SupabaseEnv,
  owner: InterviewOwner,
  now: Date = new Date(),
): Promise<MyInterviewRow[]> {
  const rows = await restGetAuthed<InterviewDbRow[]>(
    env,
    owner.accessToken,
    `race_interviews?select=id,subsession_id,audio_path,audio_type,duration_seconds,created_at` +
      `&submitter_id=eq.${encodeURIComponent(owner.userId)}&order=created_at.desc&limit=${MY_INTERVIEWS_LIMIT}`,
  );
  const rounds = await getInterviewRounds(
    env,
    rows.map((r) => r.subsession_id),
  );
  return rows.map((row) => interviewRow(row, rounds.get(row.subsession_id), now));
}

/** The tab's list, or null when it couldn't be loaded (the tab then says so; NFR4.3). */
export async function loadMyInterviews(
  env: SupabaseEnv,
  owner: InterviewOwner,
): Promise<MyInterviewRow[] | null> {
  try {
    return await getMyInterviews(env, owner);
  } catch (err) {
    // The status only: an error's text may echo the request.
    const status = err instanceof Error ? Number(/\berror (\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
    console.error('interviews load failed', 'read', status);
    return null;
  }
}

/** One of the owner's rows, or null when it isn't theirs or doesn't exist. Throws on a failed read. */
async function getMyInterviewRow(
  env: SupabaseEnv,
  owner: InterviewOwner,
  id: string,
): Promise<InterviewDbRow | null> {
  const rows = await restGetAuthed<InterviewDbRow[]>(
    env,
    owner.accessToken,
    `race_interviews?select=id,subsession_id,audio_path,audio_type,duration_seconds,created_at` +
      `&id=eq.${encodeURIComponent(id)}&submitter_id=eq.${encodeURIComponent(owner.userId)}&limit=1`,
  );
  return rows[0] ?? null;
}

export type InterviewActionCode =
  'STORAGE_FAILED' | 'RECORD_FAILED' | 'MISSING' | 'SIGN_FAILED' | 'NOT_FOUND' | 'UNKNOWN';
export type InterviewStep = 'read' | 'storage' | 'exists' | 'record' | 'sign';

/** Step, status and id only: never a path or a signed URL (NFR9.1). */
function logFailure(intent: InterviewProfileIntent, step: InterviewStep, status: number, id: string): void {
  console.error(`${intent} failed`, step, status, id);
}

export const INTERVIEW_DOWNLOAD_SECONDS = 60;

/**
 * A 60-second link that saves the original file under a clean name, signed with the owner's token (the
 * uploader read policy allows it). MISSING when the row exists but its file is gone (BR12.3).
 */
export async function signMyInterviewDownload(
  env: SupabaseEnv,
  owner: InterviewOwner,
  id: string,
): Promise<{ ok: true; url: string } | { ok: false; code: InterviewActionCode }> {
  const intent = 'download-interview';
  if (!UUID.test(id)) return { ok: false, code: 'NOT_FOUND' };
  let row: InterviewDbRow | null;
  let rounds: Map<number, InterviewRound>;
  try {
    row = await getMyInterviewRow(env, owner, id);
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    rounds = await getInterviewRounds(env, [row.subsession_id]).catch(() => new Map());
  } catch {
    logFailure(intent, 'read', 0, id);
    return { ok: false, code: 'UNKNOWN' };
  }
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${INTERVIEW_BUCKET}/${row.audio_path}`, {
      method: 'POST',
      headers: writeHeaders(env, owner.accessToken),
      body: JSON.stringify({ expiresIn: INTERVIEW_DOWNLOAD_SECONDS }),
    });
    if (!res.ok) {
      const missing = await isNotFound(res);
      logFailure(intent, 'sign', res.status, id);
      return { ok: false, code: missing ? 'MISSING' : 'SIGN_FAILED' };
    }
    const body = (await res.json().catch(() => null)) as { signedURL?: unknown } | null;
    if (typeof body?.signedURL !== 'string' || body.signedURL === '') {
      logFailure(intent, 'sign', res.status, id);
      return { ok: false, code: 'SIGN_FAILED' };
    }
    const signed = `${env.url}/storage/v1${body.signedURL.startsWith('/') ? '' : '/'}${body.signedURL}`;
    const name = encodeURIComponent(interviewDownloadName(row, rounds.get(row.subsession_id)));
    return { ok: true, url: `${signed}${signed.includes('?') ? '&' : '?'}download=${name}` };
  } catch {
    logFailure(intent, 'sign', 0, id);
    return { ok: false, code: 'SIGN_FAILED' };
  }
}

async function userRpc(env: SupabaseEnv, accessToken: string, fn: string, args: Record<string, unknown>) {
  return fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify(args),
  });
}

/** After an empty bulk-delete answer: is the file really gone? */
async function audioGoneAfterEmptyDelete(
  env: SupabaseEnv,
  owner: InterviewOwner,
  id: string,
): Promise<{ gone: true } | { gone: false; status: number }> {
  try {
    const res = await userRpc(env, owner.accessToken, 'my_interview_audio_exists', { p_id: id });
    if (!res.ok) return { gone: false, status: res.status };
    return (await res.json()) === false ? { gone: true } : { gone: false, status: res.status };
  } catch {
    return { gone: false, status: 0 };
  }
}

/**
 * Deletes the owner's interview: the audio file first, then the record, which the database refuses while the
 * file exists. Any failure keeps the row listed; a retry finds the file gone and removes the record (NFR4.1).
 */
export async function deleteMyInterview(
  env: SupabaseEnv,
  owner: InterviewOwner,
  id: string,
): Promise<{ ok: true } | { ok: false; code: InterviewActionCode }> {
  const intent = 'delete-interview';
  if (!UUID.test(id)) return { ok: false, code: 'NOT_FOUND' };
  let row: InterviewDbRow | null;
  try {
    row = await getMyInterviewRow(env, owner, id);
  } catch {
    logFailure(intent, 'read', 0, id);
    return { ok: false, code: 'UNKNOWN' };
  }
  if (!row) return { ok: false, code: 'NOT_FOUND' };

  const deleted = await bulkDeleteAudio(env, owner.accessToken, row.audio_path);
  if (!deleted.ok) {
    logFailure(intent, 'storage', deleted.status, id);
    return { ok: false, code: 'STORAGE_FAILED' };
  }
  if (!deleted.removed) {
    const check = await audioGoneAfterEmptyDelete(env, owner, id);
    if (!check.gone) {
      logFailure(intent, 'exists', check.status, id);
      return { ok: false, code: 'STORAGE_FAILED' };
    }
  }

  try {
    const res = await userRpc(env, owner.accessToken, 'delete_my_interview_record', { p_id: id });
    if (res.ok) return { ok: true };
    logFailure(intent, 'record', res.status, id);
  } catch {
    logFailure(intent, 'record', 0, id);
  }
  return { ok: false, code: 'RECORD_FAILED' };
}

// --- The tab's in-place intents (C4; NFR1.6) ---------------------------------------------------------

export const INTERVIEW_PROFILE_INTENTS = ['download-interview', 'delete-interview'] as const;
export type InterviewProfileIntent = (typeof INTERVIEW_PROFILE_INTENTS)[number];

/** The status query a no-JavaScript post redirects with (codes only). */
export const INTERVIEW_STATUS_PARAM = 'interview_status';

export const INTERVIEW_DELETED_MESSAGE = 'Interview deleted.';

export function interviewActionMessage(code: InterviewActionCode): string {
  switch (code) {
    case 'STORAGE_FAILED':
      return "Couldn't delete the audio file, so your interview was kept. Try again.";
    case 'RECORD_FAILED':
      return "The audio was deleted but the interview record wasn't. Try again.";
    case 'MISSING':
      return "This interview's audio file is missing. You can delete the entry.";
    case 'SIGN_FAILED':
      return "Couldn't prepare the download. Try again.";
    case 'NOT_FOUND':
      return "That interview wasn't found. Refresh the page and try again.";
    default:
      return "Couldn't reach the site. Try again.";
  }
}

export interface InterviewIntentResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  /** HTTP status for the JSON answer. */
  status: number;
  /** The code for the redirect's status query. */
  code: string;
  /** Without JavaScript a ready download redirects straight to its link. */
  location?: string;
}

function failureStatus(code: InterviewActionCode): number {
  return code === 'NOT_FOUND' || code === 'MISSING' ? 404 : 502;
}

/** Runs one of the tab's intents for the signed-in owner. The posted id is never trusted: RLS decides. */
export async function handleInterviewProfileIntent(
  intent: InterviewProfileIntent,
  env: SupabaseEnv,
  owner: InterviewOwner,
  form: { get(name: string): unknown },
): Promise<InterviewIntentResult> {
  const id = String(form.get('interview_id') ?? '');
  const prefix = intent === 'download-interview' ? 'download' : 'delete';
  const failure = (code: InterviewActionCode): InterviewIntentResult => ({
    ok: false,
    message: interviewActionMessage(code),
    status: failureStatus(code),
    code: `${prefix}_${code}`,
  });
  if (intent === 'download-interview') {
    const signed = await signMyInterviewDownload(env, owner, id);
    if (!signed.ok) return failure(signed.code);
    return {
      ok: true,
      message: 'Your download is starting.',
      data: { id, url: signed.url },
      status: 200,
      code: 'download_ok',
      location: signed.url,
    };
  }
  const done = await deleteMyInterview(env, owner, id);
  if (!done.ok) return failure(done.code);
  return {
    ok: true,
    message: INTERVIEW_DELETED_MESSAGE,
    data: { id, deleted: true },
    status: 200,
    code: 'deleted',
  };
}

/** The message for a no-JavaScript redirect's status code, or null for none or an unknown one. */
export function interviewStatusMessage(code: string | null): { ok: boolean; message: string } | null {
  if (!code) return null;
  if (code === 'deleted') return { ok: true, message: INTERVIEW_DELETED_MESSAGE };
  const failed =
    /^(?:download|delete)_(STORAGE_FAILED|RECORD_FAILED|MISSING|SIGN_FAILED|NOT_FOUND|UNKNOWN)$/.exec(code);
  return failed ? { ok: false, message: interviewActionMessage(failed[1] as InterviewActionCode) } : null;
}
