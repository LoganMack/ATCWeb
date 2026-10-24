/**
 * Driver-submitted incident appeals (0093): the appeal window and the DB/storage helpers. The window (Site
 * Properties, in hours) counts from when the round's incident report was posted, so an unposted round has
 * appeals closed (Logan). The database also enforces the window, per-user limits and upload folder (0113).
 */

import { restGet, restGetAuthed, restPatch, type SupabaseEnv } from './db/client';
import { getSiteSettings } from './db/assets';
import { siteSettingInt, INCIDENT_APPEAL_PERIOD_HOURS_KEY } from './siteSettings';
import { getRoundPostedAt } from './incidentReports';

export const APPEAL_MAX_FILES = 3;
/** Mirrors the 'incident-appeals' bucket's file_size_limit (0113). */
export const APPEAL_MAX_FILE_MB = 5;
export const APPEAL_MAX_FILE_BYTES = APPEAL_MAX_FILE_MB * 1024 * 1024;
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
  const [postedAt, hours] = await Promise.all([
    getRoundPostedAt(env, subsessionId),
    getAppealPeriodHours(env),
  ]);
  if (!postedAt) return null;
  return new Date(postedAt.getTime() + hours * 3_600_000);
}

export function isAppealOpen(closesAt: Date | null, now: Date = new Date()): boolean {
  return closesAt !== null && now.getTime() < closesAt.getTime();
}

/** File name made safe to use inside a storage object path. */
export function safeAppealFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(-80);
  return cleaned || 'file';
}

/** Uploads one attached file into the private bucket, under the signed-in user's own `<user id>/` folder (the bucket's insert policy, 0113). Throws on failure. */
export async function uploadAppealFile(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  file: File,
): Promise<void> {
  const res = await fetch(`${env.url}/storage/v1/object/${APPEAL_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!res.ok) throw new Error(`Appeal file upload failed (${res.status}): ${await res.text()}`);
}

/** Records the appeal (SECURITY DEFINER function, 0093; signed-in only since 0113). Throws on failure. */
export async function createIncidentAppeal(
  env: SupabaseEnv,
  accessToken: string,
  input: { id: string; penalty_id: string; message: string; files: AppealFileMeta[] },
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_incident_appeal`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_id: input.id,
      p_penalty_id: input.penalty_id,
      p_message: input.message,
      p_files: input.files,
    }),
  });
  if (!res.ok)
    throw new Error(`Supabase rpc error ${res.status} on submit_incident_appeal: ${await res.text()}`);
}

/** Admin read. */
export async function getIncidentAppealsForSubsession(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
): Promise<IncidentAppeal[]> {
  return restGetAuthed<IncidentAppeal[]>(
    env,
    accessToken,
    `incident_appeals?select=*&subsession_id=eq.${subsessionId}&order=created_at.asc`,
  );
}

/** A driver's comment on a pending incident report (U5, driver_incident_comments). */
export interface DriverIncidentComment {
  id: string;
  report_id: string;
  driver_id: string;
  body: string;
  created_at: string;
}

/**
 * Admin read of the drivers' comments on these reports, oldest first. Row Level Security returns nothing on
 * a report the admin is involved in (BR11.7), so the caller needs no filter of its own.
 */
export async function getDriverCommentsForReports(
  env: SupabaseEnv,
  accessToken: string,
  reportIds: string[],
): Promise<DriverIncidentComment[]> {
  const ids = reportIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return [];
  return restGetAuthed<DriverIncidentComment[]>(
    env,
    accessToken,
    `driver_incident_comments?select=id,report_id,driver_id,body,created_at&report_id=in.(${ids.join(',')})&order=created_at.asc`,
  );
}

/** The round a visible (posted, or any for an admin) penalty belongs to, or null when it can't be seen. */
export async function getPenaltySubsession(env: SupabaseEnv, penaltyId: string): Promise<number | null> {
  const rows = await restGet<{ subsession_id: number }[]>(
    env,
    `penalties_shown?select=subsession_id&id=eq.${encodeURIComponent(penaltyId)}`,
  );
  return rows[0]?.subsession_id ?? null;
}

export async function setIncidentAppealStatus(
  env: SupabaseEnv,
  accessToken: string,
  appealId: string,
  status: 'open' | 'reviewed' | 'dismissed',
): Promise<void> {
  await restPatch(env, accessToken, `incident_appeals?id=eq.${encodeURIComponent(appealId)}`, { status });
}

/** Admin: a one-hour download link for one attached file (the bucket is private). Null when it can't be signed. */
export async function signAppealFileUrl(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${APPEAL_BUCKET}/${path}`, {
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
