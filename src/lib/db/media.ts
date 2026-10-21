import { restDelete, restGet, restPatch, restPost, type SupabaseEnv } from './client';

// ---------------------------------------------------------------------------
// MEDIA PAGE — videos (cinematics/educational/other), graphics, meetups
// (0049_media_page.sql). Broadcasts and Track Guide, the Videos tab's other
// two filters, aren't stored here — see getAllBroadcastRaceLinks above and
// the track_guides table (0053_track_guides.sql).
// ---------------------------------------------------------------------------

export type MediaVideoCategory = 'cinematic' | 'educational' | 'other';

export interface MediaVideo {
  id: string;
  category: MediaVideoCategory;
  title: string;
  youtube_url: string;
  created_at: string;
}

const MEDIA_VIDEO_SELECT = 'id,category,title,youtube_url,created_at';

/** Every admin-entered video (cinematics + educational + other combined), newest first — the public Media page filters this client-side... no, server-side by re-querying per filter; this is the one used by the admin list, which shows all three categories together. */
export function getAllMediaVideos(env: SupabaseEnv) {
  return restGet<MediaVideo[]>(env, `media_videos?select=${MEDIA_VIDEO_SELECT}&order=created_at.desc`);
}

/** One category's videos, newest first — powers the public Media page's Cinematics/Educational/Other filters. */
export function getMediaVideosByCategory(env: SupabaseEnv, category: MediaVideoCategory) {
  return restGet<MediaVideo[]>(
    env,
    `media_videos?select=${MEDIA_VIDEO_SELECT}&category=eq.${encodeURIComponent(category)}&order=created_at.desc`,
  );
}

export function createMediaVideo(
  env: SupabaseEnv,
  accessToken: string,
  data: { category: MediaVideoCategory; title: string; youtube_url: string },
) {
  return restPost<MediaVideo>(env, accessToken, 'media_videos', data);
}

export function updateMediaVideo(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<Pick<MediaVideo, 'category' | 'title' | 'youtube_url'>>,
) {
  return restPatch<MediaVideo>(env, accessToken, `media_videos?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteMediaVideo(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `media_videos?id=eq.${encodeURIComponent(id)}`);
}

export interface MediaGraphic {
  id: string;
  title: string;
  image_url: string;
  created_at: string;
}

const MEDIA_GRAPHIC_SELECT = 'id,title,image_url,created_at';

/** Every uploaded graphic, newest first — powers both the admin list and the public Media page's Graphics tab. */
export function getAllMediaGraphics(env: SupabaseEnv) {
  return restGet<MediaGraphic[]>(env, `media_graphics?select=${MEDIA_GRAPHIC_SELECT}&order=created_at.desc`);
}

export function createMediaGraphic(
  env: SupabaseEnv,
  accessToken: string,
  data: { title: string; image_url: string },
) {
  return restPost<MediaGraphic>(env, accessToken, 'media_graphics', data);
}

export function deleteMediaGraphic(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `media_graphics?id=eq.${encodeURIComponent(id)}`);
}

export interface MediaMeetup {
  id: string;
  title: string;
  photo_url: string | null;
  /** Admin-entered directly (no geocoding) — see 0049_media_page.sql. */
  latitude: number;
  longitude: number;
  location_label: string | null;
  meetup_date: string | null; // 'YYYY-MM-DD'
  created_at: string;
}

const MEDIA_MEETUP_SELECT = 'id,title,photo_url,latitude,longitude,location_label,meetup_date,created_at';

/** Every meetup, newest first — powers both the admin list and the public Media page's Meetups map (one pin per row). */
export function getAllMediaMeetups(env: SupabaseEnv) {
  return restGet<MediaMeetup[]>(env, `media_meetups?select=${MEDIA_MEETUP_SELECT}&order=created_at.desc`);
}

export function createMediaMeetup(
  env: SupabaseEnv,
  accessToken: string,
  data: {
    title: string;
    photo_url?: string | null;
    latitude: number;
    longitude: number;
    location_label?: string | null;
    meetup_date?: string | null;
  },
) {
  return restPost<MediaMeetup>(env, accessToken, 'media_meetups', data);
}

export function updateMediaMeetup(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<Omit<MediaMeetup, 'id' | 'created_at'>>,
) {
  return restPatch<MediaMeetup>(env, accessToken, `media_meetups?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteMediaMeetup(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `media_meetups?id=eq.${encodeURIComponent(id)}`);
}

// --- Meetup attendees (0070_meetup_drivers.sql) -----------------------------
// Which roster drivers showed up to a given meetup — a plain many-to-many
// join, managed as its own add/remove mini-list on the Meetups section of
// Admin -> Media, independent of a meetup's own title/photo/location form.
// Same "own table, own mini-list" pattern as TrackGuide above.

export interface MeetupDriverLink {
  meetup_id: string;
  driver_id: string;
  /** Embedded via PostgREST FK join — null would mean an orphaned link (driver deleted without cascading, which the FK's `on delete cascade` should prevent in practice). */
  drivers: { name: string; car_number: number | null } | null;
}

/** Every meetup/driver link on file in one query — powers the public Media page's Meetups popup (grouped by meetup_id in memory) the same way getAllTrackGuides front-loads every layout's guides instead of querying per-meetup. */
export function getAllMeetupDriverLinks(env: SupabaseEnv) {
  return restGet<MeetupDriverLink[]>(
    env,
    `media_meetup_drivers?select=meetup_id,driver_id,drivers(name,car_number)`,
  );
}

export function addMeetupDriver(env: SupabaseEnv, accessToken: string, meetupId: string, driverId: string) {
  return restPost(env, accessToken, 'media_meetup_drivers', { meetup_id: meetupId, driver_id: driverId });
}

export function removeMeetupDriver(
  env: SupabaseEnv,
  accessToken: string,
  meetupId: string,
  driverId: string,
) {
  return restDelete(
    env,
    accessToken,
    `media_meetup_drivers?meetup_id=eq.${encodeURIComponent(meetupId)}&driver_id=eq.${encodeURIComponent(driverId)}`,
  );
}
