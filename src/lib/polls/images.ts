/**
 * Option image paths in the public poll-images bucket (BR4.2, BR4.3). The database checks the same pattern
 * in save_poll, so a path built here is always accepted for its own poll.
 */

export const POLL_IMAGE_BUCKET = 'poll-images';

export const POLL_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function pollImageExtension(contentType: string): string | null {
  return POLL_IMAGE_EXTENSIONS[contentType] ?? null;
}

/** Letters, digits, `_` and `-` only, at most 40 characters; 'option' when nothing is left. */
function safePrefix(prefix: string): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned || 'option';
}

/** `<poll id>/<prefix>-<timestamp>.<ext>`, or null for a file type the bucket refuses. */
export function pollImagePath(
  pollId: string,
  prefix: string,
  contentType: string,
  timestamp: number,
): string | null {
  const ext = pollImageExtension(contentType);
  if (!ext) return null;
  return `${pollId}/${safePrefix(prefix)}-${Math.max(0, Math.trunc(timestamp))}.${ext}`;
}

/** True when the path sits directly in this poll's folder, as save_poll requires. */
export function isPollImagePath(pollId: string, path: string): boolean {
  const escaped = pollId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}/[A-Za-z0-9_-]+-[0-9]+\\.(png|jpg|webp)$`).test(path);
}

/** The public URL of a stored path; callers show it through resizedImageUrl, never at full size (NFR2). */
export function pollImagePublicUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${POLL_IMAGE_BUCKET}/${path}`;
}
