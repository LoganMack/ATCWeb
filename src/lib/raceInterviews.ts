/**
 * Post-race "media pen" interviews (0109_race_interviews.sql).
 *
 * A signed-in user linked to a roster driver records up to INTERVIEW_MAX_SECONDS
 * of audio on a round's results page; the browser posts the clip to the results
 * fragment (`intent=submit-interview`), which uploads it to the private
 * 'race-interviews' bucket and records it through submit_race_interview. Admins
 * list and play them under Admin > Interviews.
 */

import { restGetAuthed, type SupabaseEnv } from './supabase';

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

/** Admin: removes the audio file, then the row. */
export async function deleteRaceInterview(
  env: SupabaseEnv,
  accessToken: string,
  interview: Pick<RaceInterview, 'id' | 'audio_path'>,
): Promise<void> {
  await fetch(`${env.url}/storage/v1/object/${INTERVIEW_BUCKET}/${interview.audio_path}`, {
    method: 'DELETE',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined);
  const res = await fetch(`${env.url}/rest/v1/race_interviews?id=eq.${encodeURIComponent(interview.id)}`, {
    method: 'DELETE',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status} on race_interviews: ${await res.text()}`);
}
