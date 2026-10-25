/**
 * The rulebook (public.rulebook_versions, 20261104120000_rulebook_versions.sql): the public page reads only
 * the newest version; the admin editor lists the last 10 and saves through save_rulebook_version(), which
 * enforces admin-only writes, the stale-editor check and the 10-version trim in the database.
 */
import { restGet, restGetAuthed, type SupabaseEnv } from './client';

export const RULEBOOK_LABEL_MAX = 40;
export const RULEBOOK_BODY_MAX = 200_000;

export interface RulebookVersion {
  id: number;
  version_label: string;
  body_md: string;
  saved_at: string;
}

export interface RulebookVersionSummary {
  id: number;
  version_label: string;
  saved_at: string;
  saved_by_name: string | null;
}

export type RulebookSaveErrorCode =
  'INVALID_LABEL' | 'INVALID_BODY' | 'STALE_VERSION' | 'NOT_ADMIN' | 'NOT_FOUND' | 'UNKNOWN';

export type RulebookSaveResult =
  { ok: true; id: number } | { ok: false; code: RulebookSaveErrorCode; message: string };

export interface RulebookSaveInput {
  label: string;
  body: string;
  /** The newest version id the editor was opened on; null when there was none. */
  expectedLatestId: number | null;
}

const VERSION_COLUMNS = 'id,version_label,body_md,saved_at';

const MESSAGES: Record<RulebookSaveErrorCode, string> = {
  INVALID_LABEL: `Enter a version label of 1 to ${RULEBOOK_LABEL_MAX} characters.`,
  INVALID_BODY: `Enter the rulebook text (at most ${RULEBOOK_BODY_MAX.toLocaleString('en-US')} characters).`,
  STALE_VERSION:
    'Someone else saved the rulebook after you opened the editor, so nothing was saved. Your text is still below: open the latest version, copy your changes into it, then save again.',
  NOT_ADMIN: 'Only admins can save the rulebook.',
  NOT_FOUND: "That version doesn't exist any more.",
  UNKNOWN: "Couldn't save the rulebook. Try again.",
};

function failure(code: RulebookSaveErrorCode): RulebookSaveResult {
  return { ok: false, code, message: MESSAGES[code] };
}

/** The newest version, or null before anything is published. One row, never the history (NFR5). */
export async function getLatestRulebook(env: SupabaseEnv): Promise<RulebookVersion | null> {
  const rows = await restGet<RulebookVersion[]>(
    env,
    `rulebook_versions?select=${VERSION_COLUMNS}&order=id.desc&limit=1`,
  );
  return rows[0] ?? null;
}

/** The saved versions, newest first, without their text. Admin pages only (reads saver names). */
export async function listRulebookVersions(
  env: SupabaseEnv,
  accessToken: string,
): Promise<RulebookVersionSummary[]> {
  const rows = await restGetAuthed<
    { id: number; version_label: string; saved_at: string; saver: { display_name: string | null } | null }[]
  >(
    env,
    accessToken,
    'rulebook_versions?select=id,version_label,saved_at,saver:profiles(display_name)&order=id.desc&limit=10',
  );
  return rows.map((r) => ({
    id: r.id,
    version_label: r.version_label,
    saved_at: r.saved_at,
    saved_by_name: r.saver?.display_name ?? null,
  }));
}

/** A positive integer id from form or query input, else null. */
export function parseRulebookVersionId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw.trim())) return null;
  const id = Number(raw.trim());
  return id > 0 ? id : null;
}

export async function getRulebookVersion(
  env: SupabaseEnv,
  accessToken: string,
  id: number,
): Promise<RulebookVersion | null> {
  const rows = await restGetAuthed<RulebookVersion[]>(
    env,
    accessToken,
    `rulebook_versions?select=${VERSION_COLUMNS}&id=eq.${id}&limit=1`,
  );
  return rows[0] ?? null;
}

/** Trims the label and normalises line endings; the database repeats these checks. */
export function shapeRulebookInput(
  label: unknown,
  body: unknown,
): { ok: true; label: string; body: string } | { ok: false; code: 'INVALID_LABEL' | 'INVALID_BODY' } {
  const cleanLabel = typeof label === 'string' ? label.trim() : '';
  if (cleanLabel.length === 0 || cleanLabel.length > RULEBOOK_LABEL_MAX)
    return { ok: false, code: 'INVALID_LABEL' };
  const cleanBody = typeof body === 'string' ? body.replace(/\r\n?/g, '\n') : '';
  if (!/\S/.test(cleanBody) || cleanBody.length > RULEBOOK_BODY_MAX)
    return { ok: false, code: 'INVALID_BODY' };
  return { ok: true, label: cleanLabel, body: cleanBody };
}

/** The code a save_rulebook_version error body carries ('<CODE>: ...'), as a result code. */
export function rulebookErrorCode(errorBody: unknown): RulebookSaveErrorCode {
  const message =
    errorBody &&
    typeof errorBody === 'object' &&
    typeof (errorBody as { message?: unknown }).message === 'string'
      ? (errorBody as { message: string }).message
      : typeof errorBody === 'string'
        ? errorBody
        : '';
  const match = /^([A-Z_]+):\s*(?:([a-z_]+):)?/.exec(message.trim());
  if (!match) return 'UNKNOWN';
  if (match[1] === 'INVALID') return match[2] === 'version_label' ? 'INVALID_LABEL' : 'INVALID_BODY';
  if (match[1] === 'STALE_VERSION' || match[1] === 'NOT_ADMIN') return match[1];
  return 'UNKNOWN';
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Saves a new latest version as the signed-in admin. Invalid input never reaches the database. */
export async function saveRulebookVersion(
  env: SupabaseEnv,
  accessToken: string,
  input: RulebookSaveInput,
): Promise<RulebookSaveResult> {
  const shaped = shapeRulebookInput(input.label, input.body);
  if (!shaped.ok) return failure(shaped.code);
  let res: Response;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/save_rulebook_version`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_version_label: shaped.label,
        p_body_md: shaped.body,
        p_expected_latest_id: input.expectedLatestId,
      }),
    });
  } catch (err) {
    console.error('save_rulebook_version could not reach the database:', err);
    return failure('UNKNOWN');
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    const code = rulebookErrorCode(body);
    if (code === 'UNKNOWN') console.error(`save_rulebook_version failed (${res.status}):`, body);
    else console.warn('save_rulebook_version refused:', code);
    return failure(code);
  }
  return { ok: true, id: Number(await res.json()) };
}

/** Saves an older version's label and text again as the new latest version (so the 10-version trim applies). */
export async function restoreRulebookVersion(
  env: SupabaseEnv,
  accessToken: string,
  id: number,
  expectedLatestId: number | null,
): Promise<RulebookSaveResult> {
  let version: RulebookVersion | null;
  try {
    version = await getRulebookVersion(env, accessToken, id);
  } catch (err) {
    console.error('Failed to load the rulebook version to restore:', err);
    return failure('UNKNOWN');
  }
  if (!version) return failure('NOT_FOUND');
  return saveRulebookVersion(env, accessToken, {
    label: version.version_label,
    body: version.body_md,
    expectedLatestId,
  });
}
