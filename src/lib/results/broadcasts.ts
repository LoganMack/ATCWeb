import { restGet, type SupabaseEnv } from '../db/client';
import {
  getAllBroadcastRaceLinks,
  getExhibitionRoundIds,
  getTestRoundIds,
  getAllPhotoAlbumRaceLinks,
  getAllReplayRaceLinks,
} from '../db/rounds';
import { getAllRounds, getRoundsForSeason, computeDisplayRoundNumbers } from './rounds';

/** One race's broadcast link, joined with its round's track/date/season for display — what the Media page's Videos → Broadcasts filter (the tab's default) actually renders. */
export interface BroadcastVideo {
  subsession_id: number;
  season_id: string;
  race_number: number;
  broadcast_url: string;
  track_name: string;
  season_label: string | null;
  start_time: string;
}

/**
 * Every broadcast link on file, newest round first — joins
 * getAllBroadcastRaceLinks() (supabase.ts, the raw race_links rows) with
 * getAllRounds() (this file) for the track/date/season context the
 * Broadcasts filter displays alongside each link. A race_links row whose
 * round has no matching curated_rounds entry (shouldn't normally happen,
 * but curated_rounds is an externally-populated table this repo doesn't
 * control — see this file's header) is skipped rather than shown with
 * blank context.
 */
export async function getAllBroadcastVideos(env: SupabaseEnv): Promise<BroadcastVideo[]> {
  const [links, rounds] = await Promise.all([getAllBroadcastRaceLinks(env), getAllRounds(env)]);
  const roundBySubsession = new Map(rounds.map((r) => [r.subsession_id, r]));
  const out: BroadcastVideo[] = [];
  for (const link of links) {
    if (!link.broadcast_url) continue;
    const round = roundBySubsession.get(link.subsession_id);
    if (!round) continue;
    out.push({
      subsession_id: link.subsession_id,
      season_id: round.season_id,
      race_number: link.race_number,
      broadcast_url: link.broadcast_url,
      track_name: round.track_name,
      season_label: round.season_label,
      start_time: round.start_time,
    });
  }
  out.sort((a, b) => b.start_time.localeCompare(a.start_time));
  return out;
}

/**
 * Everything the homepage's Previous Broadcast subtitle needs beyond what a
 * BroadcastVideo carries: this round's site-wide display "Round N" (the same
 * exhibition/test-skipping numbering computeDisplayRoundNumbers gives the
 * results page — null for an exhibition/test round) and its layout name
 * (curated_rounds.layout, falling back to the attached calendar event's
 * layout — a freshly imported round often has the former unset until an
 * admin fills it in). Fetches are small and run concurrently; every one
 * degrades to null on failure rather than breaking the page.
 */
export async function getBroadcastRoundDetails(
  env: SupabaseEnv,
  subsessionId: number,
  seasonId: string,
): Promise<{ roundNumber: number | null; layout: string | null }> {
  const [roundNumber, layout] = await Promise.all([
    (async () => {
      try {
        const [seasonRounds, exhibitionIds, testIds] = await Promise.all([
          getRoundsForSeason(env, seasonId),
          getExhibitionRoundIds(env),
          getTestRoundIds(env),
        ]);
        return computeDisplayRoundNumbers(seasonRounds, exhibitionIds, testIds).get(subsessionId) ?? null;
      } catch (err) {
        console.error('Failed to compute the broadcast round number:', err);
        return null;
      }
    })(),
    (async () => {
      try {
        const rows = await restGet<{ layout: string | null; event_id: string | null }[]>(
          env,
          `curated_rounds?select=layout,event_id&subsession_id=eq.${subsessionId}`,
        );
        const round = rows[0];
        if (!round) return null;
        if (round.layout) return round.layout;
        if (!round.event_id) return null;
        const events = await restGet<{ layout: string | null }[]>(
          env,
          `events?select=layout&id=eq.${round.event_id}`,
        );
        return events[0]?.layout ?? null;
      } catch (err) {
        console.error('Failed to look up the broadcast round layout:', err);
        return null;
      }
    })(),
  ]);
  return { roundNumber, layout };
}

/** One round's photographer photo album link, joined with its round's track/date/season for display — what the Media page's Graphics tab renders as its "Round Photo Albums" list. Same shape as BroadcastVideo above, one field renamed. */
export interface PhotoAlbumLink {
  subsession_id: number;
  race_number: number;
  photo_album_url: string;
  track_name: string;
  season_label: string | null;
  start_time: string;
}

/**
 * Every photo album link on file, newest round first — same join as
 * getAllBroadcastVideos above (getAllPhotoAlbumRaceLinks + getAllRounds),
 * just against photo_album_url instead of broadcast_url. The Media page
 * doesn't try to derive a thumbnail from the URL itself the way
 * youtubeThumbnailUrl does for broadcasts — album URLs are almost always
 * Flickr, which has no predictable per-album image URL to construct
 * without an API key. Thumbnails for these are fetched lazily client-side
 * instead, one small request per album against /api/photo-album-thumbnail
 * (see that route's own doc comment for why it's split out that way).
 */
export async function getAllPhotoAlbumLinks(env: SupabaseEnv): Promise<PhotoAlbumLink[]> {
  const [links, rounds] = await Promise.all([getAllPhotoAlbumRaceLinks(env), getAllRounds(env)]);
  const roundBySubsession = new Map(rounds.map((r) => [r.subsession_id, r]));
  const out: PhotoAlbumLink[] = [];
  for (const link of links) {
    if (!link.photo_album_url) continue;
    const round = roundBySubsession.get(link.subsession_id);
    if (!round) continue;
    out.push({
      subsession_id: link.subsession_id,
      race_number: link.race_number,
      photo_album_url: link.photo_album_url,
      track_name: round.track_name,
      season_label: round.season_label,
      start_time: round.start_time,
    });
  }
  out.sort((a, b) => b.start_time.localeCompare(a.start_time));
  return out;
}

/** One race's replay download link, joined with its round's track/date/season for display — what the Media page's Replays tab renders. Same shape as BroadcastVideo/PhotoAlbumLink above, one field renamed. */
export interface ReplayLink {
  subsession_id: number;
  race_number: number;
  replay_url: string;
  track_name: string;
  season_label: string | null;
  start_time: string;
}

/**
 * Every replay link on file, newest round first — same join as
 * getAllBroadcastVideos/getAllPhotoAlbumLinks above (getAllReplayRaceLinks +
 * getAllRounds), just against replay_url instead. Admins set this field on
 * the round's own results page (src/pages/results/[subsessionId].astro)
 * alongside broadcast_url/photo_album_url/etc.
 */
export async function getAllReplayLinks(env: SupabaseEnv): Promise<ReplayLink[]> {
  const [links, rounds] = await Promise.all([getAllReplayRaceLinks(env), getAllRounds(env)]);
  const roundBySubsession = new Map(rounds.map((r) => [r.subsession_id, r]));
  const out: ReplayLink[] = [];
  for (const link of links) {
    if (!link.replay_url) continue;
    const round = roundBySubsession.get(link.subsession_id);
    if (!round) continue;
    out.push({
      subsession_id: link.subsession_id,
      race_number: link.race_number,
      replay_url: link.replay_url,
      track_name: round.track_name,
      season_label: round.season_label,
      start_time: round.start_time,
    });
  }
  out.sort((a, b) => b.start_time.localeCompare(a.start_time));
  return out;
}
