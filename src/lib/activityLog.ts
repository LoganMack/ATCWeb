/**
 * Admin Activity Log (/admin/activity-log): one best-effort row per admin mutation, written right after the
 * mutation succeeds so a failed action is never logged. logActivity never throws: a broken log write must not
 * fail the real action.
 */
import { restPost, type SupabaseEnv } from './db/client';
import { uploadToStorage } from './db/assets';
import { userDisplayName } from './auth';

export type ActivityAction = 'add' | 'edit' | 'delete';

export interface ActivityLogRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_name: string;
  action: ActivityAction;
  entity_type: string;
  entity_label: string | null;
  entity_id: string | null;
  details: string | null;
  file_url: string | null;
  file_name: string | null;
}

export interface LogActivityInput {
  action: ActivityAction;
  /** e.g. 'driver', 'team', 'event', 'circuit', 'organization', 'ruleset', 'season', 'incident', 'photo', 'site_property', 'user', 'import'. Free text on purpose — see 0051_activity_log.sql's header for why this isn't a check()-constrained enum. */
  entity_type: string;
  /** Human-readable "what" — a driver's name, a site setting's key, a season's name, etc. Shown as the main line of the log row. */
  entity_label?: string | null;
  entity_id?: string | number | null;
  /** Freeform extra context shown as a secondary line — e.g. which ruleset a recalculation used, which role a user was changed to, which property changed and its new value. */
  details?: string | null;
  /** Only meaningful for entity_type: 'import' — the object path of the uploaded spreadsheet in the private 'imports' bucket (older rows hold its old public URL). The log page signs it for download; see signImportFileUrls. */
  file_url?: string | null;
  file_name?: string | null;
}

const IMPORTS_BUCKET = 'imports' as const;
const IMPORTS_PUBLIC_MARKER = `/storage/v1/object/public/${IMPORTS_BUCKET}/`;

/**
 * Object path inside the 'imports' bucket for a stored file_url: new rows hold
 * the path itself, rows from before the bucket went private (0115) hold its
 * public URL. Null for anything else.
 */
export function importObjectPath(fileUrl: string | null | undefined): string | null {
  if (!fileUrl) return null;
  const markerAt = fileUrl.indexOf(IMPORTS_PUBLIC_MARKER);
  let path = markerAt >= 0 ? fileUrl.slice(markerAt + IMPORTS_PUBLIC_MARKER.length) : fileUrl;
  try {
    path = decodeURIComponent(path.split('?')[0]);
  } catch {
    return null;
  }
  if (/^[a-z]+:/i.test(path) || path.startsWith('/') || path.includes('..') || path.length === 0) return null;
  return path;
}

/** Uploads an import spreadsheet and returns its object path (the value to store in file_url). Throws on failure. */
export async function storeImportSpreadsheet(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  file: File,
): Promise<string> {
  await uploadToStorage(env, accessToken, IMPORTS_BUCKET, path, file);
  return path;
}

/**
 * Admin: one-hour download links for import spreadsheets, keyed by the stored
 * file_url. One batch request; rows that can't be signed are left out (logged).
 */
export async function signImportFileUrls(
  env: SupabaseEnv,
  accessToken: string,
  fileUrls: (string | null)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pathByUrl = new Map<string, string>();
  for (const url of fileUrls) {
    const path = importObjectPath(url);
    if (url && path) pathByUrl.set(url, path);
  }
  if (pathByUrl.size === 0) return out;
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${IMPORTS_BUCKET}`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600, paths: [...new Set(pathByUrl.values())] }),
    });
    if (!res.ok) throw new Error(`Storage sign error ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as { path?: string; signedURL?: string | null; error?: string | null }[];
    const signedByPath = new Map<string, string>();
    for (const row of rows) {
      if (row.path && row.signedURL) {
        signedByPath.set(
          row.path,
          `${env.url}/storage/v1${row.signedURL.startsWith('/') ? '' : '/'}${row.signedURL}`,
        );
      }
    }
    for (const [url, path] of pathByUrl) {
      const signed = signedByPath.get(path);
      if (signed) out.set(url, signed);
    }
  } catch (err) {
    console.error('Failed to sign import download links:', err);
  }
  return out;
}

/**
 * The actor label, resolved like AdminLayout.astro's header so the log shows the name the admin sees for
 * themselves.
 */
export function actorNameFor(session: {
  profile?: { display_name: string | null; driver_name?: string | null; iracing_name?: string | null } | null;
  user: { email: string | null };
}): string {
  return userDisplayName(session.profile, session.user.email);
}

/**
 * Writes one activity_log row; RLS requires actor_id = auth.uid() unless the actor is an admin (0051). Logs
 * failures instead of throwing.
 */
export async function logActivity(
  env: SupabaseEnv,
  accessToken: string,
  actor: { id: string; name: string },
  input: LogActivityInput,
): Promise<void> {
  try {
    await restPost(env, accessToken, 'activity_log', {
      actor_id: actor.id,
      actor_name: actor.name,
      action: input.action,
      entity_type: input.entity_type,
      entity_label: input.entity_label ?? null,
      entity_id: input.entity_id != null ? String(input.entity_id) : null,
      details: input.details ?? null,
      file_url: input.file_url ?? null,
      file_name: input.file_name ?? null,
    });
  } catch (err) {
    console.error('Failed to write activity_log entry:', err);
  }
}
