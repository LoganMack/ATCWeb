import { restDelete, restGet, writeHeaders, type SupabaseEnv } from './client';

// --- Champion photos (up to 5 per season+class, see /admin/champions) ------

export interface ChampionPhoto {
  id: string;
  season_id: string;
  class_id: number;
  driver_id: string;
  image_url: string;
  sort_order: number;
}

const CHAMPION_PHOTO_SELECT = 'id,season_id,class_id,driver_id,image_url,sort_order';

/** The (up to 5) uploaded photos for one season+class champion slot, in slot order. */
export function getChampionPhotos(env: SupabaseEnv, seasonId: string, classId: number) {
  return restGet<ChampionPhoto[]>(
    env,
    `champion_photos?select=${CHAMPION_PHOTO_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}&order=sort_order.asc`,
  );
}

/** Every uploaded champion photo for a class, across all seasons — one query for the whole /champions page instead of one per card. */
export function getChampionPhotosForClass(env: SupabaseEnv, classId: number) {
  return restGet<ChampionPhoto[]>(
    env,
    `champion_photos?select=${CHAMPION_PHOTO_SELECT}&class_id=eq.${classId}&order=season_id.asc,sort_order.asc`,
  );
}

/** Upserts the photo for one (season, class, sort_order) slot — replaces whatever was in that slot before. */
export async function upsertChampionPhoto(
  env: SupabaseEnv,
  accessToken: string,
  data: { season_id: string; class_id: number; driver_id: string; image_url: string; sort_order: number },
) {
  const res = await fetch(`${env.url}/rest/v1/champion_photos?on_conflict=season_id,class_id,sort_order`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, {
      Prefer: 'return=representation,resolution=merge-duplicates',
    }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on champion_photos: ${await res.text()}`);
  const rows = (await res.json()) as ChampionPhoto[];
  return rows[0];
}

export function deleteChampionPhoto(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `champion_photos?id=eq.${encodeURIComponent(id)}`);
}

// --- Hall of Fame photos (up to 5 per driver, see 0042_hall_of_fame_photos.sql) -

export interface HallOfFamePhoto {
  id: string;
  driver_id: string;
  image_url: string;
  sort_order: number;
}

const HALL_OF_FAME_PHOTO_SELECT = 'id,driver_id,image_url,sort_order';

/** The (up to 5) uploaded photos for one Hall of Fame member, in slot order. */
export function getHallOfFamePhotos(env: SupabaseEnv, driverId: string) {
  return restGet<HallOfFamePhoto[]>(
    env,
    `hall_of_fame_photos?select=${HALL_OF_FAME_PHOTO_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}&order=sort_order.asc`,
  );
}

/** Every uploaded Hall of Fame photo, across every member — one query for the whole /hall-of-fame page instead of one per member. */
export function getAllHallOfFamePhotos(env: SupabaseEnv) {
  return restGet<HallOfFamePhoto[]>(
    env,
    `hall_of_fame_photos?select=${HALL_OF_FAME_PHOTO_SELECT}&order=driver_id.asc,sort_order.asc`,
  );
}

/** Upserts the photo for one (driver, sort_order) slot — replaces whatever was in that slot before. */
export async function upsertHallOfFamePhoto(
  env: SupabaseEnv,
  accessToken: string,
  data: { driver_id: string; image_url: string; sort_order: number },
) {
  const res = await fetch(`${env.url}/rest/v1/hall_of_fame_photos?on_conflict=driver_id,sort_order`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, {
      Prefer: 'return=representation,resolution=merge-duplicates',
    }),
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(`Supabase upsert error ${res.status} on hall_of_fame_photos: ${await res.text()}`);
  const rows = (await res.json()) as HallOfFamePhoto[];
  return rows[0];
}

export function deleteHallOfFamePhoto(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `hall_of_fame_photos?id=eq.${encodeURIComponent(id)}`);
}
