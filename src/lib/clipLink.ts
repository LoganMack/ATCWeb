/**
 * Incident clip links (BR5.1, BR5.2): the check a clip URL must pass and how a clip plays. Pure and
 * dependency-light, so the server actions and the page scripts share one rule. The database checks the same
 * link again (set_incident_report_video, set_incident_video and the column checks).
 */

import { isHttpUrl } from './security';
import { youtubeEmbedUrl } from './siteSettings';

export const CLIP_URL_MAX_LENGTH = 500;
export const CLIP_URL_ERROR =
  'Video URL: enter a link starting with http:// or https:// (up to 500 characters).';

export type ClipUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/** Trims a typed clip link. An empty box means "no clip" (url ''); anything else must be a short http(s) URL. */
export function normalizeClipUrl(raw: unknown): ClipUrlCheck {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') return { ok: true, url: '' };
  // No spaces inside: the database refuses them too, and a browser would quietly encode them.
  if (url.length > CLIP_URL_MAX_LENGTH || /\s/.test(url) || !/^https?:\/\//i.test(url) || !isHttpUrl(url)) {
    return { ok: false, message: CLIP_URL_ERROR };
  }
  return { ok: true, url };
}

const FILE_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv)$/i;
const FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export type ClipKind = { kind: 'youtube'; embedUrl: string } | { kind: 'file' } | { kind: 'link' };

/**
 * How a clip plays: a YouTube link in a privacy-enhanced embed, a direct video file (by extension, or a
 * Discord attachment) in a <video>, anything else as a link. No host allow-list. Null for a link that fails
 * normalizeClipUrl, so nothing unchecked ever reaches an href or src.
 */
export function clipKind(raw: string): ClipKind | null {
  const check = normalizeClipUrl(raw);
  if (!check.ok || check.url === '') return null;
  const embedUrl = youtubeEmbedUrl(check.url);
  if (embedUrl) return { kind: 'youtube', embedUrl };
  const parsed = new URL(check.url);
  if (FILE_EXTENSIONS.test(parsed.pathname) || FILE_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { kind: 'file' };
  }
  return { kind: 'link' };
}

// --- Clip writes -----------------------------------------------------------------------------------

export type ClipWriteErrorCode =
  | 'INVALID_URL'
  | 'REPORT_NOT_FOUND'
  | 'INCIDENT_NOT_FOUND'
  | 'INCIDENT_NUMBER_REQUIRED'
  | 'NOT_ALLOWED'
  | 'UNKNOWN';

export type ClipWriteResult = { ok: true } | { ok: false; code: ClipWriteErrorCode; message: string };

export const CLIP_WRITE_MESSAGES: Record<ClipWriteErrorCode, string> = {
  INVALID_URL: CLIP_URL_ERROR,
  REPORT_NOT_FOUND: 'That incident report no longer exists.',
  INCIDENT_NOT_FOUND: 'That incident no longer exists.',
  INCIDENT_NUMBER_REQUIRED: 'Give the incident a number before adding a clip.',
  NOT_ALLOWED: 'Only an admin or staff member can change a clip.',
  UNKNOWN: "Couldn't save the clip. Try again.",
};

/** Maps a clip function's error (a PostgREST body or its message) to a code and a message the page can show. */
export function mapClipWriteError(text: string): Extract<ClipWriteResult, { ok: false }> {
  let message = text;
  const json = text.indexOf('{');
  if (json >= 0) {
    try {
      const body = JSON.parse(text.slice(json)) as { message?: unknown; code?: unknown };
      if (body.code === '42501')
        return { ok: false, code: 'NOT_ALLOWED', message: CLIP_WRITE_MESSAGES.NOT_ALLOWED };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // not JSON: match the raw text
    }
  }
  const code = /^([A-Z_]+):/.exec(message.trim())?.[1];
  if (
    code === 'INVALID_URL' ||
    code === 'REPORT_NOT_FOUND' ||
    code === 'INCIDENT_NOT_FOUND' ||
    code === 'INCIDENT_NUMBER_REQUIRED'
  ) {
    return { ok: false, code, message: CLIP_WRITE_MESSAGES[code] };
  }
  if (/Only an admin or staff member/.test(message)) {
    return { ok: false, code: 'NOT_ALLOWED', message: CLIP_WRITE_MESSAGES.NOT_ALLOWED };
  }
  return { ok: false, code: 'UNKNOWN', message: CLIP_WRITE_MESSAGES.UNKNOWN };
}

/** A failed clip write as a result to show; logs the function and the code only, never the link. */
export function clipWriteFailure(name: string, err: unknown): Extract<ClipWriteResult, { ok: false }> {
  const mapped = mapClipWriteError(err instanceof Error ? err.message : String(err));
  console.error(`${name} failed`, mapped.code);
  return mapped;
}
