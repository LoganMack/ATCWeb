/**
 * History > Interviews for signed-in members (driver-profile-polish FR8). Every read goes through
 * race_interviews_shown with the member's own token: the view returns nothing to anon and leaves out drivers
 * hidden from the caller (20261107120000_interviews_members_view.sql). Audio is signed one play at a time,
 * so listing interviews downloads nothing.
 */
import { restGetAuthed, type SupabaseEnv } from './db/client';
import privacyReads from './privacyReads.json';
import { INTERVIEW_BUCKET } from './raceInterviews';

export interface MemberInterview {
  id: string;
  subsession_id: number;
  driver_id: string;
  duration_seconds: number;
  created_at: string;
  /** From drivers_shown; null when the driver row is gone. */
  drivers: { id: string; name: string; car_number: number | null; is_hidden: boolean } | null;
}

/** At most this many interviews per read (one season's list). */
export const MEMBER_INTERVIEWS_LIMIT = 300;
/** A signed play link lives this long: enough to start playing, too short to share. */
export const MEMBER_AUDIO_LINK_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The interviews of these rounds, newest first, read as the member. Throws on a failed read. */
export async function getMemberInterviews(
  env: SupabaseEnv,
  accessToken: string,
  subsessionIds: number[],
): Promise<MemberInterview[]> {
  const ids = [...new Set(subsessionIds)].filter((id) => Number.isSafeInteger(id));
  if (ids.length === 0) return [];
  const { path, select } = privacyReads.interviewsShown;
  return restGetAuthed<MemberInterview[]>(
    env,
    accessToken,
    `${path}?select=${encodeURIComponent(select)}&subsession_id=in.(${ids.join(',')})` +
      `&order=created_at.desc&limit=${MEMBER_INTERVIEWS_LIMIT}`,
  );
}

/**
 * A short-lived play link for one interview, signed with the member's token: the storage policy allows it only
 * when race_interviews_shown shows the member that interview. Null when the view shows no such row (signed
 * out, a hidden driver, or an unknown id). Throws when a read or the signing fails.
 */
export async function signMemberInterviewAudio(
  env: SupabaseEnv,
  accessToken: string,
  interviewId: string,
): Promise<string | null> {
  if (!UUID.test(interviewId)) return null;
  const rows = await restGetAuthed<{ audio_path: string }[]>(
    env,
    accessToken,
    `${privacyReads.interviewsShown.path}?select=audio_path&id=eq.${interviewId}&limit=1`,
  );
  const audioPath = rows[0]?.audio_path;
  if (!audioPath) return null;

  const res = await fetch(`${env.url}/storage/v1/object/sign/${INTERVIEW_BUCKET}/${audioPath}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: MEMBER_AUDIO_LINK_SECONDS }),
  });
  if (!res.ok) throw new Error(`Interview audio sign failed (${res.status})`);
  const body = (await res.json()) as { signedURL?: string };
  if (!body.signedURL) throw new Error('Interview audio sign returned no link');
  return `${env.url}/storage/v1${body.signedURL.startsWith('/') ? '' : '/'}${body.signedURL}`;
}

/** "1:05" for a clip length in seconds. */
export function formatInterviewLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
