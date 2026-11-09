/**
 * Shrinks an option image in the browser before the poll editor submits it (polls BR4.1), so a normal save
 * stays well under the server's body limit. The size decisions are pure and tested; the canvas part runs only
 * in the browser and falls back to the original file whenever it cannot do better.
 */

/** The longest side an option image keeps; the public page shows them at 320 px. */
export const POLL_IMAGE_MAX_SIDE = 1600;

/** A PNG at or under this size and within the longest side is kept as it is (logos, diagrams). */
export const POLL_PNG_KEEP_BYTES = 300 * 1024;

/** A JPEG or WebP at or under this size and within the longest side is not re-encoded. */
export const POLL_IMAGE_KEEP_BYTES = 500 * 1024;

const QUALITY = 0.85;

/** The width and height that fit inside `max` on the longest side, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  max = POLL_IMAGE_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest <= 0) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a file already small enough in pixels and bytes should be sent as it is. */
export function keepOriginal(type: string, bytes: number, width: number, height: number): boolean {
  if (Math.max(width, height) > POLL_IMAGE_MAX_SIDE) return false;
  if (type === 'image/png') return bytes <= POLL_PNG_KEEP_BYTES;
  return bytes <= POLL_IMAGE_KEEP_BYTES;
}

/** The file name for a re-encoded image: the original name with the new extension. */
export function resizedName(name: string, type: string): string {
  const base = name.replace(/\.[^.]*$/, '') || 'image';
  return `${base}.${type === 'image/webp' ? 'webp' : 'jpg'}`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/**
 * The file to send for `file`: the original when it is small enough or cannot be decoded, otherwise a WebP
 * (or JPEG where the browser cannot encode WebP) at most 1600 px on the longest side, if that is smaller.
 */
export async function shrinkPollImage(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    if (keepOriginal(file.type, file.size, bitmap.width, bitmap.height)) return file;
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    let blob = await canvasBlob(canvas, 'image/webp');
    // A browser that cannot encode WebP hands back a PNG instead.
    if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg');
    if (!blob || (blob.type !== 'image/webp' && blob.type !== 'image/jpeg') || blob.size >= file.size)
      return file;
    return new File([blob], resizedName(file.name, blob.type), { type: blob.type, lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}
