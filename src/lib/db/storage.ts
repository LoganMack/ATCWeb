import type { RestClient } from './client';
import type { StorageBucket } from './types';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Best-effort file extension for an upload: trust the filename when it has a
 * plausible one, otherwise fall back to the MIME type. Was inline in the
 * team edit page; lifted here because driver photo uploads need the same
 * thing and shouldn't reimplement it.
 */
export function extFromFile(file: File): string {
  const fromName = file.name.split('.').pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  return EXT_BY_MIME[file.type] ?? 'png';
}

export function storageRepo(rest: RestClient) {
  return {
    /** Uploads to a public bucket and returns the object's public URL. */
    upload(bucket: StorageBucket, objectPath: string, file: File) {
      return rest.upload(bucket, objectPath, file);
    },

    /**
     * Uploads under a cache-busting, collision-free name derived from the
     * owning record's id. Timestamped so a replaced logo/photo doesn't get
     * served from a stale CDN cache under the old URL.
     */
    uploadFor(bucket: StorageBucket, ownerId: string, file: File) {
      return rest.upload(bucket, `${ownerId}-${Date.now()}.${extFromFile(file)}`, file);
    },
  };
}
