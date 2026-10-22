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
 * Every broadcast link, newest round first, joined with its round for the track/date/season context. Links
 * whose round is missing from the externally-populated curated_rounds are skipped.
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
 * What the homepage's Previous Broadcast subtitle needs beyond a BroadcastVideo: the display round number
 * (null for exhibition/test) and the layout name (falling back to the event's). Each fetch degrades to null.
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
 * Every photo album link, newest round first. Album URLs are mostly Flickr, which can't give a thumbnail URL
 * without an API key, so thumbnails load lazily via /api/photo-album-thumbnail.
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

/** Every replay link, newest round first, joined with its round like getAllBroadcastVideos. */
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
