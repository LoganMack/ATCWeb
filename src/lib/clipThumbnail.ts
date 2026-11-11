/**
 * What a report's video thumbnail shows on Reported Incidents (FR2.3; BR2.3): YouTube's still image for a YouTube
 * link, otherwise a plain tile with a play symbol. Either way, clicking it opens the video in the popup player.
 */
import { youtubeThumbnailUrl } from './db/circuits';

export type ClipThumbnail = { kind: 'youtube'; imageUrl: string } | { kind: 'tile' };

export function clipThumbnail(url: string): ClipThumbnail {
  const imageUrl = youtubeThumbnailUrl(url);
  return imageUrl ? { kind: 'youtube', imageUrl } : { kind: 'tile' };
}
