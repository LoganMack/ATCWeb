/**
 * The own profile's Liveries tab (profile-liveries FR5): a league driver's iRacing paint files per season, kept
 * in the private 'liveries' bucket. The rules live in the database (20261106120000_liveries.sql): owner-only
 * rows and folders, 3 per season, one active, files before rows. File bytes never pass through the Worker: this
 * module signs upload and download links with the owner's token and the browser moves the bytes (NFR4).
 */

import { restGetAuthed, writeHeaders, type SupabaseEnv } from './db/client';
import { getSeasons } from './db/seasons';

export const LIVERY_BUCKET = 'liveries';
/** Per file as selected, before gzip (FR5.10); the bucket allows 21 MB for the compressed object. */
export const LIVERY_MAX_BYTES = 20 * 1024 * 1024;
export const LIVERIES_PER_SEASON = 3;
export const LIVERY_DOWNLOAD_SECONDS = 60;
export const LIVERY_PREVIEW_SECONDS = 300;
export const LIVERY_THUMB_SECONDS = 3600;
export const LIVERY_IMAGE_TYPES = ['image/webp', 'image/jpeg'] as const;
export type LiveryImageType = (typeof LIVERY_IMAGE_TYPES)[number];

export type LiveryFile = 'base' | 'spec' | 'thumb' | 'preview';
const FILE_NAMES: Record<LiveryFile, string> = {
  base: 'base.tga.gz',
  spec: 'spec.mip.gz',
  thumb: 'thumb',
  preview: 'preview',
};

/** The signed-in owner. Rows are filtered by profile too, so an admin's own tab lists only theirs. */
export interface LiveryOwner {
  accessToken: string;
  userId: string;
}

/** "<profile id>/<livery id>/<file>": the storage policies only let an account write in its own folder. */
export function liveryPath(profileId: string, liveryId: string, file: LiveryFile): string {
  return `${profileId}/${liveryId}/${FILE_NAMES[file]}`;
}

// --- Input shaping (the database repeats every check) ---------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLiveryUuid(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return UUID.test(value) ? value.toLowerCase() : null;
}

/** The file's own name (no folders, no control characters), 5-200 characters, ending in `ext`; else null. */
export function cleanLiveryFileName(raw: unknown, ext: '.tga' | '.mip'): string | null {
  const text = typeof raw === 'string' ? raw : '';
  const name = (text.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (name.length < ext.length + 1 || name.length > 200) return null;
  return name.toLowerCase().endsWith(ext) ? name : null;
}

/** A selected file's size in bytes: a whole number from 1 to 20 MB, else null. */
export function parseLiverySize(raw: unknown): number | null {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!/^\d{1,9}$/.test(text)) return null;
  const size = Number(text);
  return size >= 1 && size <= LIVERY_MAX_BYTES ? size : null;
}

export function parseLiveryImageType(raw: unknown): LiveryImageType | null {
  return (LIVERY_IMAGE_TYPES as readonly unknown[]).includes(raw) ? (raw as LiveryImageType) : null;
}

// --- Errors ---------------------------------------------------------------------------------------

export type LiveryActionCode =
  | 'INVALID'
  | 'LIMIT_REACHED'
  | 'FILES_MISSING'
  | 'NOT_LINKED'
  | 'NOT_OWNER'
  | 'NOT_FOUND'
  | 'MISSING'
  | 'CONFLICT'
  | 'SIGN_FAILED'
  | 'STORAGE_FAILED'
  | 'UNKNOWN';

const RAISED_CODES = new Set<string>(['LIMIT_REACHED', 'FILES_MISSING', 'NOT_OWNER']);

/** A PostgREST error body (or its text) as a code: raised '<CODE>: …', an RLS refusal, a unique clash. */
export function mapLiveryDbError(body: unknown): LiveryActionCode {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { message: body };
    }
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const message = typeof obj.message === 'string' ? obj.message.trim() : '';
  const raised = /^([A-Z_]+):/.exec(message)?.[1];
  if (raised && RAISED_CODES.has(raised)) return raised as LiveryActionCode;
  if (obj.code === '42501') return 'NOT_LINKED';
  if (obj.code === '23505') return 'CONFLICT';
  if (obj.code === '23514' || obj.code === '22P02') return 'INVALID';
  return 'UNKNOWN';
}

export const LIVERY_INVALID_MESSAGES = {
  tga: 'Pick a .tga file as the base livery.',
  mip: 'Pick a .mip file as the spec map.',
  size: `Files can be at most ${LIVERY_MAX_BYTES / 1024 / 1024} MB.`,
  season: 'Pick a season.',
  images: "Couldn't make the livery images. Try again.",
  id: "That livery wasn't found. Refresh the page and try again.",
} as const;

export function liveryActionMessage(code: LiveryActionCode): string {
  switch (code) {
    case 'INVALID':
      return 'Check the file and the season, then try again.';
    case 'LIMIT_REACHED':
      return `A season can hold at most ${LIVERIES_PER_SEASON} liveries. Delete one or pick another season.`;
    case 'FILES_MISSING':
      return "The files didn't finish uploading. Try again.";
    case 'NOT_LINKED':
      return 'Only accounts linked to a driver can upload liveries.';
    case 'NOT_OWNER':
    case 'NOT_FOUND':
      return "That livery wasn't found. Refresh the page and try again.";
    case 'MISSING':
      return "This livery's file is missing. You can delete the entry.";
    case 'CONFLICT':
      return 'Another change to your liveries was saved at the same time. Refresh and try again.';
    case 'SIGN_FAILED':
      return "Couldn't prepare the file link. Try again.";
    case 'STORAGE_FAILED':
      return "Couldn't delete the stored files, so your livery was kept. Try again.";
    default:
      return "Couldn't reach the site. Try again.";
  }
}

function failureStatus(code: LiveryActionCode): number {
  if (code === 'INVALID') return 400;
  if (code === 'NOT_LINKED') return 403;
  if (code === 'NOT_FOUND' || code === 'NOT_OWNER' || code === 'MISSING') return 404;
  if (code === 'LIMIT_REACHED' || code === 'CONFLICT') return 409;
  return 502;
}

/** Intent, step and status only: never a path, a name or a signed URL. */
function logFailure(intent: string, step: string, status: number): void {
  console.error(`${intent} failed`, step, status);
}

// --- Storage --------------------------------------------------------------------------------------

const storageUrl = (env: SupabaseEnv, signed: string) =>
  `${env.url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;

/** A one-use upload link for `path`; with `upsert` it may replace an existing object. Null when refused. */
export async function signLiveryUpload(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  upsert = false,
): Promise<string | null> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/upload/sign/${LIVERY_BUCKET}/${path}`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken, upsert ? { 'x-upsert': 'true' } : undefined),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    return typeof body?.url === 'string' && body.url !== '' ? storageUrl(env, body.url) : null;
  } catch {
    return null;
  }
}

type SignedDownload = { ok: true; url: string } | { ok: false; missing: boolean };

/** A short-lived read link for one object; `missing` tells a gone file apart from a refusal. */
export async function signLiveryDownload(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  seconds: number,
): Promise<SignedDownload> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${LIVERY_BUCKET}/${path}`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify({ expiresIn: seconds }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const missing = res.status === 404 || /"statusCode"\s*:\s*"?404|not_found|not found/i.test(text);
      return { ok: false, missing };
    }
    const body = (await res.json().catch(() => null)) as { signedURL?: unknown } | null;
    return typeof body?.signedURL === 'string' && body.signedURL !== ''
      ? { ok: true, url: storageUrl(env, body.signedURL) }
      : { ok: false, missing: false };
  } catch {
    return { ok: false, missing: false };
  }
}

/** One batch request signing every thumbnail for an hour; a path that can't be signed is left out. */
export async function signLiveryThumbs(
  env: SupabaseEnv,
  accessToken: string,
  paths: string[],
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  if (paths.length === 0) return signed;
  try {
    const res = await fetch(`${env.url}/storage/v1/object/sign/${LIVERY_BUCKET}`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify({ expiresIn: LIVERY_THUMB_SECONDS, paths }),
    });
    if (!res.ok) {
      logFailure('liveries load', 'thumbs', res.status);
      return signed;
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) return signed;
    for (const item of body as { path?: unknown; signedURL?: unknown }[]) {
      if (typeof item?.path === 'string' && typeof item.signedURL === 'string' && item.signedURL !== '') {
        signed.set(item.path, storageUrl(env, item.signedURL));
      }
    }
  } catch {
    logFailure('liveries load', 'thumbs', 0);
  }
  return signed;
}

/** Storage's bulk delete as the owner. True when the request was accepted (missing objects count as gone). */
export async function removeLiveryObjects(
  env: SupabaseEnv,
  accessToken: string,
  paths: string[],
): Promise<boolean> {
  try {
    const res = await fetch(`${env.url}/storage/v1/object/${LIVERY_BUCKET}`, {
      method: 'DELETE',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify({ prefixes: paths }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Reads ----------------------------------------------------------------------------------------

export interface LiveryDbRow {
  id: string;
  season_id: string;
  tga_name: string;
  tga_size: number;
  mip_name: string | null;
  mip_size: number | null;
  is_active: boolean;
  created_at: string;
}

const ROW_SELECT = 'id,season_id,tga_name,tga_size,mip_name,mip_size,is_active,created_at';

export interface LiveryRow {
  id: string;
  seasonId: string;
  tgaName: string;
  tgaSize: number;
  mipName: string | null;
  mipSize: number | null;
  isActive: boolean;
  createdAt: string;
  thumbUrl: string | null;
}

export interface LiverySeason {
  id: string;
  number: number;
  label: string;
  isCurrent: boolean;
}

export interface LiverySeasonGroup {
  season: LiverySeason;
  rows: LiveryRow[];
}

export interface LiveriesPanelData {
  /** Every season, newest first, for the dropdowns (FR5.2). */
  seasons: LiverySeason[];
  /** Only seasons that hold liveries, newest first (FR5.8). */
  groups: LiverySeasonGroup[];
  /** The current season, else the newest; preselected for a new upload. */
  defaultSeasonId: string | null;
}

/** The season's name, or "Season <number>" when it has none. */
export function liverySeasonLabel(season: { name: string | null; number: number }): string {
  return season.name?.trim() || `Season ${season.number}`;
}

export function defaultLiverySeasonId(seasons: LiverySeason[]): string | null {
  return (seasons.find((s) => s.isCurrent) ?? seasons[0])?.id ?? null;
}

/** Groups rows by season, newest season first; within a season the active livery comes first, then newest. */
export function groupLiveries(rows: LiveryRow[], seasons: LiverySeason[]): LiverySeasonGroup[] {
  const ordered = [...seasons].sort((a, b) => b.number - a.number);
  const byId = new Map(ordered.map((s) => [s.id, s]));
  const buckets = new Map<string, LiveryRow[]>();
  for (const row of rows) buckets.set(row.seasonId, [...(buckets.get(row.seasonId) ?? []), row]);
  const sortRows = (list: LiveryRow[]) =>
    [...list].sort(
      (a, b) => Number(b.isActive) - Number(a.isActive) || b.createdAt.localeCompare(a.createdAt),
    );
  const groups = ordered
    .filter((s) => buckets.has(s.id))
    .map((season) => ({ season, rows: sortRows(buckets.get(season.id) ?? []) }));
  for (const [id, list] of buckets) {
    if (!byId.has(id)) {
      groups.push({
        season: { id, number: 0, label: 'Unknown season', isCurrent: false },
        rows: sortRows(list),
      });
    }
  }
  return groups;
}

function toRow(row: LiveryDbRow, thumbUrl: string | null): LiveryRow {
  return {
    id: row.id,
    seasonId: row.season_id,
    tgaName: row.tga_name,
    tgaSize: row.tga_size,
    mipName: row.mip_name,
    mipSize: row.mip_size,
    isActive: row.is_active,
    createdAt: row.created_at,
    thumbUrl,
  };
}

/** The tab's data, or null when it couldn't be loaded (the tab then says so). */
export async function loadMyLiveries(
  env: SupabaseEnv,
  owner: LiveryOwner,
): Promise<LiveriesPanelData | null> {
  try {
    const [seasonRows, dbRows] = await Promise.all([
      getSeasons(env),
      restGetAuthed<LiveryDbRow[]>(
        env,
        owner.accessToken,
        `liveries?select=${ROW_SELECT}&profile_id=eq.${encodeURIComponent(owner.userId)}&order=created_at.desc`,
      ),
    ]);
    const seasons: LiverySeason[] = seasonRows.map((s) => ({
      id: s.id,
      number: s.number,
      label: liverySeasonLabel(s),
      isCurrent: s.is_current,
    }));
    const thumbPaths = dbRows.map((r) => liveryPath(owner.userId, r.id, 'thumb'));
    const thumbs = await signLiveryThumbs(env, owner.accessToken, thumbPaths);
    const rows = dbRows.map((r) => toRow(r, thumbs.get(liveryPath(owner.userId, r.id, 'thumb')) ?? null));
    return { seasons, groups: groupLiveries(rows, seasons), defaultSeasonId: defaultLiverySeasonId(seasons) };
  } catch (err) {
    // The status only: an error's text may echo the request.
    const status = err instanceof Error ? Number(/\berror (\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
    logFailure('liveries load', 'read', status);
    return null;
  }
}

/** One of the owner's rows, or null when it isn't theirs or doesn't exist. Throws on a failed read. */
async function getMyLivery(env: SupabaseEnv, owner: LiveryOwner, id: string): Promise<LiveryDbRow | null> {
  const rows = await restGetAuthed<LiveryDbRow[]>(
    env,
    owner.accessToken,
    `liveries?select=${ROW_SELECT}&id=eq.${encodeURIComponent(id)}` +
      `&profile_id=eq.${encodeURIComponent(owner.userId)}&limit=1`,
  );
  return rows[0] ?? null;
}

/** How many liveries the owner keeps in a season; the database repeats the count under a lock. */
async function countInSeason(env: SupabaseEnv, owner: LiveryOwner, seasonId: string): Promise<number> {
  const rows = await restGetAuthed<{ id: string }[]>(
    env,
    owner.accessToken,
    `liveries?select=id&profile_id=eq.${encodeURIComponent(owner.userId)}` +
      `&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
  return rows.length;
}

// --- The tab's in-place intents ---------------------------------------------------------------------

export const LIVERY_PROFILE_INTENTS = [
  'prepare-livery',
  'create-livery',
  'prepare-livery-mip',
  'set-livery-mip',
  'livery-files',
  'livery-preview',
  'set-livery-season',
  'set-livery-active',
  'delete-livery',
] as const;
export type LiveryProfileIntent = (typeof LIVERY_PROFILE_INTENTS)[number];

/** The status query a no-JavaScript post redirects with (codes only). */
export const LIVERY_STATUS_PARAM = 'livery_status';

export interface LiveryIntentResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
  /** HTTP status for the JSON answer. */
  status: number;
  /** The code for the redirect's status query. */
  code: string;
}

type Form = { get(name: string): unknown };

const fail = (code: LiveryActionCode, message?: string): LiveryIntentResult => ({
  ok: false,
  message: message ?? liveryActionMessage(code),
  status: failureStatus(code),
  code: `error_${code}`,
});

const done = (message: string, data?: Record<string, unknown>): LiveryIntentResult => ({
  ok: true,
  message,
  ...(data ? { data } : {}),
  status: 200,
  code: 'done',
});

/** A REST write as the owner; an error answer becomes its code. */
async function restWrite(
  env: SupabaseEnv,
  owner: LiveryOwner,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; code: LiveryActionCode; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${env.url}/rest/v1/${path}`, {
      method,
      headers: writeHeaders(env, owner.accessToken, { Prefer: 'return=representation' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, code: 'UNKNOWN', status: 0 };
  }
  if (!res.ok)
    return { ok: false, code: mapLiveryDbError(await res.text().catch(() => '')), status: res.status };
  const rows = (await res.json().catch(() => [])) as unknown;
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

interface ShapedUpload {
  seasonId: string;
  tgaName: string;
  tgaSize: number;
}

function shapeUpload(form: Form): ShapedUpload | LiveryIntentResult {
  const seasonId = parseLiveryUuid(form.get('season_id'));
  if (!seasonId) return fail('INVALID', LIVERY_INVALID_MESSAGES.season);
  const tgaName = cleanLiveryFileName(form.get('tga_name'), '.tga');
  if (!tgaName) return fail('INVALID', LIVERY_INVALID_MESSAGES.tga);
  const tgaSize = parseLiverySize(form.get('tga_size'));
  if (!tgaSize) return fail('INVALID', LIVERY_INVALID_MESSAGES.size);
  return { seasonId, tgaName, tgaSize };
}

const isResult = (value: unknown): value is LiveryIntentResult =>
  Boolean(value) && typeof (value as LiveryIntentResult).ok === 'boolean';

/** Checks the upload, refuses a full season early, and signs the three upload links for a new livery id. */
async function prepareLivery(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const shaped = shapeUpload(form);
  if (isResult(shaped)) return shaped;
  if (!parseLiveryImageType(form.get('thumb_type')) || !parseLiveryImageType(form.get('preview_type'))) {
    return fail('INVALID', LIVERY_INVALID_MESSAGES.images);
  }
  try {
    if ((await countInSeason(env, owner, shaped.seasonId)) >= LIVERIES_PER_SEASON)
      return fail('LIMIT_REACHED');
  } catch {
    logFailure('prepare-livery', 'read', 0);
    return fail('UNKNOWN');
  }
  const id = crypto.randomUUID();
  const files = ['base', 'thumb', 'preview'] as const;
  const urls = await Promise.all(
    files.map((f) => signLiveryUpload(env, owner.accessToken, liveryPath(owner.userId, id, f))),
  );
  if (urls.some((u) => u === null)) {
    logFailure('prepare-livery', 'sign', 0);
    return fail('SIGN_FAILED');
  }
  return done('Uploading…', { id, uploads: { base: urls[0], thumb: urls[1], preview: urls[2] } });
}

/** Records the livery once its files are stored; a refused row takes its uploaded files with it. */
async function createLivery(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const id = parseLiveryUuid(form.get('livery_id'));
  if (!id) return fail('INVALID', LIVERY_INVALID_MESSAGES.id);
  const shaped = shapeUpload(form);
  if (isResult(shaped)) return shaped;
  const written = await restWrite(env, owner, 'POST', 'liveries', {
    id,
    season_id: shaped.seasonId,
    tga_name: shaped.tgaName,
    tga_size: shaped.tgaSize,
  });
  if (written.ok) return done('Livery uploaded.', { id });
  logFailure('create-livery', 'record', written.status);
  // A clash on the id may be an existing livery, whose files must stay.
  if (written.code !== 'CONFLICT') {
    const paths = (['base', 'thumb', 'preview'] as const).map((f) => liveryPath(owner.userId, id, f));
    await removeLiveryObjects(env, owner.accessToken, paths);
  }
  return fail(written.code);
}

/** The owner's livery for an intent that needs one, or the failure to answer with. */
async function ownLivery(
  env: SupabaseEnv,
  owner: LiveryOwner,
  form: Form,
  intent: LiveryProfileIntent,
): Promise<LiveryDbRow | LiveryIntentResult> {
  const id = parseLiveryUuid(form.get('livery_id'));
  if (!id) return fail('NOT_FOUND');
  try {
    return (await getMyLivery(env, owner, id)) ?? fail('NOT_FOUND');
  } catch {
    logFailure(intent, 'read', 0);
    return fail('UNKNOWN');
  }
}

function shapeMip(form: Form): { mipName: string; mipSize: number } | LiveryIntentResult {
  const mipName = cleanLiveryFileName(form.get('mip_name'), '.mip');
  if (!mipName) return fail('INVALID', LIVERY_INVALID_MESSAGES.mip);
  const mipSize = parseLiverySize(form.get('mip_size'));
  if (!mipSize) return fail('INVALID', LIVERY_INVALID_MESSAGES.size);
  return { mipName, mipSize };
}

async function prepareMip(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const mip = shapeMip(form);
  if (isResult(mip)) return mip;
  const row = await ownLivery(env, owner, form, 'prepare-livery-mip');
  if (isResult(row)) return row;
  // Replacing the spec map overwrites the same object.
  const url = await signLiveryUpload(env, owner.accessToken, liveryPath(owner.userId, row.id, 'spec'), true);
  if (!url) {
    logFailure('prepare-livery-mip', 'sign', 0);
    return fail('SIGN_FAILED');
  }
  return done('Uploading…', { id: row.id, url, upsert: true });
}

async function setMip(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const id = parseLiveryUuid(form.get('livery_id'));
  if (!id) return fail('NOT_FOUND');
  const mip = shapeMip(form);
  if (isResult(mip)) return mip;
  const written = await restWrite(
    env,
    owner,
    'PATCH',
    `liveries?id=eq.${encodeURIComponent(id)}&profile_id=eq.${encodeURIComponent(owner.userId)}`,
    { mip_name: mip.mipName, mip_size: mip.mipSize },
  );
  if (!written.ok) {
    logFailure('set-livery-mip', 'record', written.status);
    return fail(written.code);
  }
  return written.rows.length > 0 ? done('Spec map saved.', { id }) : fail('NOT_FOUND');
}

/** Signs the original files' download links: the .tga and, when there is one, the .mip (FR5.6). */
async function liveryFiles(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const row = await ownLivery(env, owner, form, 'livery-files');
  if (isResult(row)) return row;
  const wanted: { file: LiveryFile; name: string }[] = [{ file: 'base', name: row.tga_name }];
  if (row.mip_name) wanted.push({ file: 'spec', name: row.mip_name });
  const signed = await Promise.all(
    wanted.map((w) =>
      signLiveryDownload(
        env,
        owner.accessToken,
        liveryPath(owner.userId, row.id, w.file),
        LIVERY_DOWNLOAD_SECONDS,
      ),
    ),
  );
  const files: { name: string; url: string }[] = [];
  for (const [i, s] of signed.entries()) {
    if (!s.ok) {
      logFailure('livery-files', 'sign', 0);
      return fail(s.missing ? 'MISSING' : 'SIGN_FAILED');
    }
    files.push({ name: wanted[i].name, url: s.url });
  }
  return done('Your download is starting.', { id: row.id, files });
}

async function liveryPreview(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const row = await ownLivery(env, owner, form, 'livery-preview');
  if (isResult(row)) return row;
  const path = liveryPath(owner.userId, row.id, 'preview');
  const signed = await signLiveryDownload(env, owner.accessToken, path, LIVERY_PREVIEW_SECONDS);
  if (!signed.ok) {
    logFailure('livery-preview', 'sign', 0);
    return fail(signed.missing ? 'MISSING' : 'SIGN_FAILED');
  }
  return done('', { id: row.id, url: signed.url, name: row.tga_name });
}

async function setSeason(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const id = parseLiveryUuid(form.get('livery_id'));
  if (!id) return fail('NOT_FOUND');
  const seasonId = parseLiveryUuid(form.get('season_id'));
  if (!seasonId) return fail('INVALID', LIVERY_INVALID_MESSAGES.season);
  const written = await restWrite(
    env,
    owner,
    'PATCH',
    `liveries?id=eq.${encodeURIComponent(id)}&profile_id=eq.${encodeURIComponent(owner.userId)}`,
    { season_id: seasonId },
  );
  if (!written.ok) {
    logFailure('set-livery-season', 'record', written.status);
    return fail(written.code);
  }
  return written.rows.length > 0 ? done('Livery moved.', { id }) : fail('NOT_FOUND');
}

async function setActive(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const id = parseLiveryUuid(form.get('livery_id'));
  if (!id) return fail('NOT_FOUND');
  const written = await restWrite(env, owner, 'POST', 'rpc/set_my_livery_active', { p_id: id });
  if (!written.ok) {
    logFailure('set-livery-active', 'record', written.status);
    return fail(written.code);
  }
  return done('Active livery set.', { id });
}

/** Removes the stored files first, then the row, so a failure never leaves a row without its files hidden. */
async function deleteLivery(env: SupabaseEnv, owner: LiveryOwner, form: Form): Promise<LiveryIntentResult> {
  const row = await ownLivery(env, owner, form, 'delete-livery');
  if (isResult(row)) return row;
  const paths = (['base', 'spec', 'thumb', 'preview'] as const).map((f) =>
    liveryPath(owner.userId, row.id, f),
  );
  if (!(await removeLiveryObjects(env, owner.accessToken, paths))) {
    logFailure('delete-livery', 'storage', 0);
    return fail('STORAGE_FAILED');
  }
  const written = await restWrite(
    env,
    owner,
    'DELETE',
    `liveries?id=eq.${encodeURIComponent(row.id)}&profile_id=eq.${encodeURIComponent(owner.userId)}`,
  );
  if (!written.ok) {
    logFailure('delete-livery', 'record', written.status);
    return fail(written.code);
  }
  return done('Livery deleted.', { id: row.id, deleted: true });
}

const HANDLERS: Record<
  LiveryProfileIntent,
  (env: SupabaseEnv, owner: LiveryOwner, form: Form) => Promise<LiveryIntentResult>
> = {
  'prepare-livery': prepareLivery,
  'create-livery': createLivery,
  'prepare-livery-mip': prepareMip,
  'set-livery-mip': setMip,
  'livery-files': liveryFiles,
  'livery-preview': liveryPreview,
  'set-livery-season': setSeason,
  'set-livery-active': setActive,
  'delete-livery': deleteLivery,
};

/** Runs one of the tab's intents for the signed-in owner. Posted ids are never trusted: RLS decides. */
export function handleLiveryProfileIntent(
  intent: LiveryProfileIntent,
  env: SupabaseEnv,
  owner: LiveryOwner,
  form: Form,
): Promise<LiveryIntentResult> {
  return HANDLERS[intent](env, owner, form);
}

/** The message for a no-JavaScript redirect's status code, or null for none or an unknown one. */
export function liveryStatusMessage(code: string | null): { ok: boolean; message: string } | null {
  if (!code) return null;
  if (code === 'done') return { ok: true, message: 'Saved.' };
  const failed =
    /^error_(INVALID|LIMIT_REACHED|FILES_MISSING|NOT_LINKED|NOT_OWNER|NOT_FOUND|MISSING|CONFLICT|SIGN_FAILED|STORAGE_FAILED|UNKNOWN)$/.exec(
      code,
    );
  return failed ? { ok: false, message: liveryActionMessage(failed[1] as LiveryActionCode) } : null;
}
