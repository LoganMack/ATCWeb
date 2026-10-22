import { restDelete, restGet, writeHeaders, type SupabaseEnv } from './client';

// --- Car logos (see 0009_car_logos.sql) -------------------------------

export interface CarLogo {
  car_name: string;
  logo_url: string;
}

/** Every configured car logo, keyed by the car's exact name (matches `curated_race_results.car_name`). */
export function getCarLogos(env: SupabaseEnv) {
  return restGet<CarLogo[]>(env, 'car_logos?select=car_name,logo_url&order=car_name.asc');
}

/** Upserts one car's logo (by car_name). */
export async function upsertCarLogo(env: SupabaseEnv, accessToken: string, data: CarLogo) {
  const res = await fetch(`${env.url}/rest/v1/car_logos?on_conflict=car_name`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on car_logos: ${await res.text()}`);
  const rows = (await res.json()) as CarLogo[];
  return rows[0];
}

export function deleteCarLogo(env: SupabaseEnv, accessToken: string, carName: string) {
  return restDelete(env, accessToken, `car_logos?car_name=eq.${encodeURIComponent(carName)}`);
}

/** Distinct car names currently in use — each driver's current `car` field, deduped. A pragmatic stand-in for "every car found in the data": querying curated_race_results (an external, potentially huge, pipeline table) for truly distinct historical car names isn't practical over plain PostgREST. Cars that only ever appeared in past seasons and aren't any current driver's car can still be configured by typing the name directly in the admin form. */
export async function getDistinctDriverCarNames(env: SupabaseEnv): Promise<string[]> {
  const drivers = await restGet<{ car: string | null }[]>(env, 'drivers?select=car');
  const names = new Set<string>();
  for (const d of drivers) {
    if (d.car && d.car.trim()) names.add(d.car.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// --- Page banners (0024_season_logos_and_page_banners.sql) ---
// One optional background image per public page, keyed by the app's own `page_key` (src/lib/pageBanners.ts).
// No row means no banner.

export interface PageBannerRow {
  page_key: string;
  image_url: string;
}

/** Every configured page banner. Small table — callers just filter/`.find()` this in memory rather than querying per page_key. */
export function getPageBanners(env: SupabaseEnv) {
  return restGet<PageBannerRow[]>(env, 'page_banners?select=page_key,image_url');
}

/** Upserts one page's banner image (by page_key). */
export async function upsertPageBanner(env: SupabaseEnv, accessToken: string, data: PageBannerRow) {
  const res = await fetch(`${env.url}/rest/v1/page_banners?on_conflict=page_key`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on page_banners: ${await res.text()}`);
  const rows = (await res.json()) as PageBannerRow[];
  return rows[0];
}

export function deletePageBanner(env: SupabaseEnv, accessToken: string, pageKey: string) {
  return restDelete(env, accessToken, `page_banners?page_key=eq.${encodeURIComponent(pageKey)}`);
}

// --- Site settings (0026_site_settings.sql) ---
// Key/value table for one-off site-wide values; today the driver probation/inactivity thresholds (keys in
// src/lib/siteSettings.ts).

export interface SiteSettingRow {
  setting_key: string;
  value: string | null;
}

/** Every configured site setting. Small table — callers just `.find()` this in memory rather than querying per key. */
export function getSiteSettings(env: SupabaseEnv) {
  return restGet<SiteSettingRow[]>(env, 'site_settings?select=setting_key,value');
}

/** Upserts one setting (by setting_key). Pass value: null to clear it back to "unset" without deleting the row. */
export async function upsertSiteSetting(env: SupabaseEnv, accessToken: string, data: SiteSettingRow) {
  const res = await fetch(`${env.url}/rest/v1/site_settings?on_conflict=setting_key`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on site_settings: ${await res.text()}`);
  const rows = (await res.json()) as SiteSettingRow[];
  return rows[0];
}

// --- Storage (team logos, driver photos, page banners, import spreadsheets) -

/**
 * Uploads to a public Storage bucket and returns the public URL; `x-upsert` overwrites in place. The
 * 'imports' bucket (0051) keeps each bulk import's spreadsheet for its activity log download link.
 */
export async function uploadToStorage(
  env: SupabaseEnv,
  accessToken: string,
  bucket: 'logos' | 'photos' | 'banners' | 'imports',
  path: string,
  file: File,
): Promise<string> {
  const res = await fetch(`${env.url}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed (${res.status}): ${await res.text()}`);
  }
  return `${env.url}/storage/v1/object/public/${bucket}/${path}`;
}
