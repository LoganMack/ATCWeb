/**
 * Driver-submitted incident appeals (0093_incident_appeals.sql) — the appeal
 * window math plus the DB/storage helpers the Incident Report page uses.
 *
 * APPEAL WINDOW (per Logan): "Incident Appeal Window" site setting, in hours,
 * set under admin > Site Properties next to the reporting window. It counts
 * from the moment the round's incident report was POSTED — the first moment
 * drivers can see the incident at all — so a round with no posted time
 * (not posted, or posted before appeals existed) has its appeals closed.
 */

import { restGetAuthed, restPatch, getSiteSettings, type SupabaseEnv } from './supabase';
import { siteSettingInt, INCIDENT_APPEAL_PERIOD_HOURS_KEY } from './siteSettings';
import { getRoundPostedAt } from './incidentReports';

export const APPEAL_MAX_FILES = 3;
export const APPEAL_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const APPEAL_MAX_MESSAGE_LENGTH = 4000;
/** Mirrors the 'incident-appeals' bucket's allowed_mime_types (0093). */
export const APPEAL_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
];
export const APPEAL_BUCKET = 'incident-appeals';

export interface AppealFileMeta {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface IncidentAppeal {
  id: string;
  subsession_id: number;
  penalty_id: string;
  message: string;
  files: AppealFileMeta[];
  submitter_id: string | null;
  submitter_name: string | null;
  status: 'open' | 'reviewed' | 'dismissed';
  created_at: string;
}

/** The configured appeal-window length in hours (site setting, default 24). Never throws. */
export async function getAppealPeriodHours(env: SupabaseEnv): Promise<number> {
  try {
    return siteSettingInt(await getSiteSettings(env), INCIDENT_APPEAL_PERIOD_HOURS_KEY);
  } catch (err) {
    console.error('Failed to read the incident appeal window setting:', err);
    return 24;
  }
}

/** When this round's appeals close (UTC), or null when they can't be opened at all (round not posted / no posted time). */
export async function getAppealClosesAt(env: SupabaseEnv, subsessionId: number): Promise<Date | null> {
  const [postedAt, hours] = await Promise.all([getRoundPostedAt(env, subsessionId), getAppealPeriodHours(env)]);
  if (!postedAt) return null;
  return new Date(postedAt.getTime() + hours * 3_600_000);
}

export function isAppealOpen(closesAt: Date | null, now: Date = new Date()): boolean {
  return closesAt !== null && now.getTime() < closesAt.getTime();
}

/** File name made safe to use inside a storage object path. */
export function safeAppealFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80);
  return cleaned || 'file';
}

/** Uploads one attached file into the private bucket — open to signed-out visitors via the bucket's insert policy. Throws on failure. */
export async function uploadAppealFile(env: SupabaseEnv, accessToken: string | null, path: string, file: File): Promise<void> {
  const res = await fetch(`${env.url}/storage/v1/object/${APPEAL_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken ?? env.anonKey}`,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!res.ok) throw new Error(`Appeal file upload failed (${res.status}): ${await res.text()}`);
}

/** Records the appeal (SECURITY DEFINER function, 0093). Throws on failure. */
export async function createIncidentAppeal(
  env: SupabaseEnv,
  accessToken: string | null,
  input: { id: string; penalty_id: string; message: string; files: AppealFileMeta[] }
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_incident_appeal`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken ?? env.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_id: input.id, p_penalty_id: input.penalty_id, p_message: input.message, p_files: input.files }),
  });
  if (!res.ok) throw new Error(`Supabase rpc error ${res.status} on submit_incident_appeal: ${await res.text()}`);
}

/** Admin read. */
export async function getIncidentAppealsForSubsession(env: SupabaseEnv, accessToken: string, subsessionId: number): Promise<IncidentAppeal[]> {
  return restGetAuthed<IncidentAppeal[]>(env, accessToken, `incident_appeals?select=*&subsession_id=eq.${subsessionId}&order=created_at.asc`);
}

export async function setIncidentAppealStatus(
  env: SupabaseEnv,
  accessToken: string,
  appealId: string,
  status: 'open' | 'reviewed' | 'dismissed'
): Promise<void> {
  await restPatch(env, accessToken, `incident_appeals?id=eq.${encodeURIComponent(appealId)}`, { status });
}

/** Admin: a one-hour download link for one attached file (the bucket is private). Null when it can't be signed. */
export async function signAppealFileUrl(env: SupabaseEnv, accessToken: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${APPEAL_BUCKET}/${path}`, {
      method: 'POST',
      headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
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
