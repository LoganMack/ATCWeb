/**
 * Minimal PostgREST client — deliberately not using @supabase/supabase-js.
 * For a read-mostly public site, a couple of typed `fetch` wrappers against
 * Supabase's auto-generated REST API cover everything we need with zero
 * extra dependencies. Reach for the full SDK later if you add auth,
 * realtime subscriptions, or file storage.
 *
 * IMPORTANT — where the URL/key come from:
 * Every page that calls into this file has `export const prerender = false`,
 * meaning it runs per-request on Cloudflare's Worker, not at build time.
 * `import.meta.env.PUBLIC_*` only gets a value baked in at *build* time —
 * on Cloudflare's build pipeline, `wrangler.jsonc`'s `vars` (and dashboard
 * variables bound to the Worker) are a *runtime* concept, only visible via
 * `Astro.locals.runtime.env` once the Worker is actually handling a
 * request. Reading `import.meta.env` here was silently building with
 * `undefined` every time — that was the real reason nothing ever loaded in
 * production, independent of the wrangler.jsonc vars-wiping bug fixed
 * earlier. `resolveSupabaseEnv` below prefers the runtime binding and only
 * falls back to `import.meta.env` for contexts where that's genuinely the
 * right source (local `astro dev`, or a page that's actually prerendered).
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export function resolveSupabaseEnv(locals: App.Locals): SupabaseEnv {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string> } } | undefined)?.runtime?.env;
  return {
    url: runtimeEnv?.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL,
    anonKey: runtimeEnv?.PUBLIC_SUPABASE_ANON_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
  };
}

function restHeaders(env: SupabaseEnv) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${env.anonKey}`,
  };
}

// Exported (unlike the write-side helpers below) because src/lib/results.ts
// needs it directly for the results/standings tables, which aren't owned by
// this file's usual per-table CRUD pattern — see that file's header comment.
export async function restGet<T>(env: SupabaseEnv, path: string): Promise<T> {
  if (!env.url || !env.anonKey) {
    throw new Error('Supabase URL/anon key are not set (checked both the Cloudflare runtime env and import.meta.env).');
  }
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    headers: restHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`Supabase REST error ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface Driver {
  id: string;
  car_number: number | null;
  name: string;
  is_rookie: boolean;
  car: string | null;
  appearances: number;
  starts: number;
  seasons_count: number;
  penalty_points: number;
  penalty_points_max: number;
  driver_statuses: { name: string } | null;
  driver_classes: { name: string } | null;
  teams: { name: string; primary_color_hex: string | null; logo_url: string | null } | null;
}

export interface NewsPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  cover_image_url: string | null;
  author_name: string;
  published_at: string;
}

/** All drivers, ordered by class rank then car number. Embeds team/status/class names via PostgREST's resource embedding. */
export function getDrivers(env: SupabaseEnv) {
  const select =
    'id,car_number,name,is_rookie,car,appearances,starts,seasons_count,' +
    'penalty_points,penalty_points_max,' +
    'driver_statuses(name),driver_classes(name),teams(name,primary_color_hex,logo_url)';
  return restGet<Driver[]>(
    env,
    `drivers?select=${encodeURIComponent(select)}&order=car_number.asc.nullslast`
  );
}

/** Published news posts, newest first. */
export function getNewsPosts(env: SupabaseEnv, limit?: number) {
  const params = new URLSearchParams({
    select: 'id,slug,title,excerpt,body,cover_image_url,author_name,published_at',
    order: 'published_at.desc',
  });
  if (limit) params.set('limit', String(limit));
  return restGet<NewsPost[]>(env, `news_posts?${params.toString()}`);
}

/** A single published news post by slug. */
export async function getNewsPostBySlug(env: SupabaseEnv, slug: string) {
  const select = 'id,slug,title,excerpt,body,cover_image_url,author_name,published_at';
  const posts = await restGet<NewsPost[]>(
    env,
    `news_posts?select=${select}&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  return posts[0] ?? null;
}

// ---------------------------------------------------------------------------
// ADMIN / WRITE OPERATIONS
//
// Everything below requires a signed-in admin's own access token (from
// src/lib/auth.ts's Session), never the anon key — RLS in
// supabase/migrations/0002_auth_admin.sql only allows writes (and, for
// news, seeing drafts) when the request's JWT belongs to a profile with
// role = 'admin'. Passing the anon key here would just get a 401/empty
// result, not a security hole — but it also wouldn't work, so don't.
// ---------------------------------------------------------------------------

function writeHeaders(env: SupabaseEnv, accessToken: string, extra?: Record<string, string>) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function restGetAuthed<T>(env: SupabaseEnv, accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, { headers: writeHeaders(env, accessToken) });
  if (!res.ok) throw new Error(`Supabase REST error ${res.status} on ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function restPost<T>(env: SupabaseEnv, accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase insert error ${res.status} on ${path}: ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0];
}

async function restPatch<T>(env: SupabaseEnv, accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase update error ${res.status} on ${path}: ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0];
}

async function restDelete(env: SupabaseEnv, accessToken: string, path: string): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status} on ${path}: ${await res.text()}`);
}

// --- Lookups (for building <select> dropdowns in admin forms) --------------

export interface Lookup {
  id: number;
  name: string;
  sort_order: number;
}

export function getDriverStatuses(env: SupabaseEnv) {
  return restGet<Lookup[]>(env, 'driver_statuses?select=id,name,sort_order&order=sort_order.asc');
}

export function getDriverClasses(env: SupabaseEnv) {
  return restGet<Lookup[]>(env, 'driver_classes?select=id,name,sort_order&order=sort_order.asc');
}

// --- Teams -------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  primary_color_hex: string | null;
  logo_url: string | null;
}

/** All teams (active + inactive) — the public Teams page splits them into two sections itself. */
export function getTeams(env: SupabaseEnv) {
  return restGet<Team[]>(env, 'teams?select=id,name,status,primary_color_hex,logo_url&order=name.asc');
}

export async function getTeamById(env: SupabaseEnv, id: string) {
  const teams = await restGet<Team[]>(
    env,
    `teams?select=id,name,status,primary_color_hex,logo_url&id=eq.${encodeURIComponent(id)}`
  );
  return teams[0] ?? null;
}

export function createTeam(env: SupabaseEnv, accessToken: string, data: Partial<Team>) {
  return restPost<Team>(env, accessToken, 'teams', data);
}

export function updateTeam(env: SupabaseEnv, accessToken: string, id: string, data: Partial<Team>) {
  return restPatch<Team>(env, accessToken, `teams?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteTeam(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `teams?id=eq.${encodeURIComponent(id)}`);
}

// --- Drivers (admin — raw FK columns, not the embedded/joined shape) -------

export interface DriverRecord {
  id: string;
  car_number: number | null;
  name: string;
  status_id: number;
  class_id: number;
  team_id: string | null;
  is_rookie: boolean;
  car: string | null;
  appearances: number;
  starts: number;
  seasons_count: number;
  penalty_points: number;
  penalty_points_max: number;
  photo_url: string | null;
  bio: string | null;
}

const DRIVER_ADMIN_SELECT =
  'id,car_number,name,status_id,class_id,team_id,is_rookie,car,appearances,starts,' +
  'seasons_count,penalty_points,penalty_points_max,photo_url,bio';

export async function getDriverById(env: SupabaseEnv, id: string) {
  const drivers = await restGet<DriverRecord[]>(
    env,
    `drivers?select=${DRIVER_ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`
  );
  return drivers[0] ?? null;
}

export function createDriver(env: SupabaseEnv, accessToken: string, data: Partial<DriverRecord>) {
  return restPost<DriverRecord>(env, accessToken, 'drivers', data);
}

export function updateDriver(env: SupabaseEnv, accessToken: string, id: string, data: Partial<DriverRecord>) {
  return restPatch<DriverRecord>(env, accessToken, `drivers?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteDriver(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `drivers?id=eq.${encodeURIComponent(id)}`);
}

// --- News (admin) ------------------------------------------------------

export interface NewsPostAdmin extends NewsPost {
  status: 'draft' | 'published';
}

const NEWS_ADMIN_SELECT = 'id,slug,title,excerpt,body,cover_image_url,author_name,status,published_at';

/** Drafts + published, newest first — requires an admin's access token (RLS-gated). */
export function getAllNewsPosts(env: SupabaseEnv, accessToken: string) {
  return restGetAuthed<NewsPostAdmin[]>(env, accessToken, `news_posts?select=${NEWS_ADMIN_SELECT}&order=published_at.desc`);
}

export async function getNewsPostByIdAdmin(env: SupabaseEnv, accessToken: string, id: string) {
  const posts = await restGetAuthed<NewsPostAdmin[]>(
    env,
    accessToken,
    `news_posts?select=${NEWS_ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`
  );
  return posts[0] ?? null;
}

export function createNewsPost(env: SupabaseEnv, accessToken: string, data: Partial<NewsPostAdmin>) {
  return restPost<NewsPostAdmin>(env, accessToken, 'news_posts', data);
}

export function updateNewsPost(env: SupabaseEnv, accessToken: string, id: string, data: Partial<NewsPostAdmin>) {
  return restPatch<NewsPostAdmin>(env, accessToken, `news_posts?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteNewsPost(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `news_posts?id=eq.${encodeURIComponent(id)}`);
}

// --- Champion photos (up to 3 per season+class, see /admin/champions) ------

export interface ChampionPhoto {
  id: string;
  season_id: string;
  class_id: number;
  driver_id: string;
  image_url: string;
  sort_order: number;
}

const CHAMPION_PHOTO_SELECT = 'id,season_id,class_id,driver_id,image_url,sort_order';

/** The (up to 3) uploaded photos for one season+class champion slot, in slot order. */
export function getChampionPhotos(env: SupabaseEnv, seasonId: string, classId: number) {
  return restGet<ChampionPhoto[]>(
    env,
    `champion_photos?select=${CHAMPION_PHOTO_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}&class_id=eq.${classId}&order=sort_order.asc`
  );
}

/** Every uploaded champion photo for a class, across all seasons — one query for the whole /champions page instead of one per card. */
export function getChampionPhotosForClass(env: SupabaseEnv, classId: number) {
  return restGet<ChampionPhoto[]>(
    env,
    `champion_photos?select=${CHAMPION_PHOTO_SELECT}&class_id=eq.${classId}&order=season_id.asc,sort_order.asc`
  );
}

/** Upserts the photo for one (season, class, sort_order) slot — replaces whatever was in that slot before. */
export async function upsertChampionPhoto(
  env: SupabaseEnv,
  accessToken: string,
  data: { season_id: string; class_id: number; driver_id: string; image_url: string; sort_order: number }
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

// --- Storage (team logos, driver photos) --------------------------------

/**
 * Uploads a file to a public Storage bucket and returns its public URL.
 * `x-upsert: true` lets re-uploading to the same path (e.g. replacing a
 * team's logo) overwrite in place instead of erroring.
 */
export async function uploadToStorage(
  env: SupabaseEnv,
  accessToken: string,
  bucket: 'logos' | 'photos',
  path: string,
  file: File
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

// ---------------------------------------------------------------------------
// SEASONS
// ---------------------------------------------------------------------------

export interface Season {
  id: string;
  number: number;
  name: string;
  logo_url: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  /**
   * Drop weeks beyond the standard baseline (see src/lib/results.ts —
   * standings drop each driver's worst 2 + extra_drop_weeks rounds before
   * totaling points). Column lives on `seasons` in the live database
   * already; not created by this repo's migrations (see 0004_champions.sql
   * for why).
   */
  extra_drop_weeks: number;
}

/** All seasons, newest first. */
export function getSeasons(env: SupabaseEnv) {
  return restGet<Season[]>(
    env,
    'seasons?select=id,number,name,logo_url,start_date,end_date,is_current,extra_drop_weeks&order=number.desc'
  );
}

export async function getSeasonById(env: SupabaseEnv, id: string) {
  const seasons = await restGet<Season[]>(
    env,
    `seasons?select=id,number,name,logo_url,start_date,end_date,is_current,extra_drop_weeks&id=eq.${encodeURIComponent(id)}`
  );
  return seasons[0] ?? null;
}

// ---------------------------------------------------------------------------
// CALENDAR — circuits + events
// ---------------------------------------------------------------------------

// --- Circuits ------------------------------------------------------------

export interface Circuit {
  id: string;
  name: string;
  logo_url: string | null;
}

export function getCircuits(env: SupabaseEnv) {
  return restGet<Circuit[]>(env, 'circuits?select=id,name,logo_url&order=name.asc');
}

export async function getCircuitById(env: SupabaseEnv, id: string) {
  const circuits = await restGet<Circuit[]>(
    env,
    `circuits?select=id,name,logo_url&id=eq.${encodeURIComponent(id)}`
  );
  return circuits[0] ?? null;
}

export function createCircuit(env: SupabaseEnv, accessToken: string, data: Partial<Circuit>) {
  return restPost<Circuit>(env, accessToken, 'circuits', data);
}

export function updateCircuit(env: SupabaseEnv, accessToken: string, id: string, data: Partial<Circuit>) {
  return restPatch<Circuit>(env, accessToken, `circuits?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteCircuit(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `circuits?id=eq.${encodeURIComponent(id)}`);
}

// --- Events ----------------------------------------------------------------

export type Weather = 'dry' | 'mixed' | 'wet';
export type EventFormat = 'endurance' | 'sprint' | 'special';

export interface EventRecord {
  id: string;
  circuit_id: string;
  layout: string | null;
  event_date: string; // 'YYYY-MM-DD'
  format: EventFormat;
  fuel_limit_pct: number | null;
  results_url: string | null;

  practice_start_time: string | null; // 'HH:MM:SS'
  practice_minutes: number | null;
  practice_weather: Weather | null;

  qualifying_start_time: string | null;
  qualifying_minutes: number | null;
  qualifying_laps: number | null;
  qualifying_weather: Weather | null;

  race1_start_time: string;
  race1_laps: number | null;
  race1_weather: Weather | null;

  race2_start_time: string | null;
  race2_laps: number | null;
  race2_weather: Weather | null;

  race3_start_time: string | null;
  race3_laps: number | null;
  race3_weather: Weather | null;
}

export interface EventWithCircuit extends EventRecord {
  circuits: { name: string; logo_url: string | null } | null;
}

const EVENT_SELECT =
  'id,circuit_id,layout,event_date,format,fuel_limit_pct,results_url,' +
  'practice_start_time,practice_minutes,practice_weather,' +
  'qualifying_start_time,qualifying_minutes,qualifying_laps,qualifying_weather,' +
  'race1_start_time,race1_laps,race1_weather,' +
  'race2_start_time,race2_laps,race2_weather,' +
  'race3_start_time,race3_laps,race3_weather';

/** All events (with circuit name/logo embedded), soonest first. Powers the public calendar page. */
export function getEvents(env: SupabaseEnv) {
  const select = `${EVENT_SELECT},circuits(name,logo_url)`;
  return restGet<EventWithCircuit[]>(env, `events?select=${encodeURIComponent(select)}&order=event_date.asc`);
}

/** The next `limit` events from today onward — powers the homepage "Upcoming Events" widget. */
export function getUpcomingEvents(env: SupabaseEnv, limit: number) {
  const select = `${EVENT_SELECT},circuits(name,logo_url)`;
  const today = new Date().toISOString().slice(0, 10);
  return restGet<EventWithCircuit[]>(
    env,
    `events?select=${encodeURIComponent(select)}&event_date=gte.${today}&order=event_date.asc&limit=${limit}`
  );
}

export async function getEventById(env: SupabaseEnv, id: string) {
  const events = await restGet<EventRecord[]>(
    env,
    `events?select=${EVENT_SELECT}&id=eq.${encodeURIComponent(id)}`
  );
  return events[0] ?? null;
}

export function createEvent(env: SupabaseEnv, accessToken: string, data: Partial<EventRecord>) {
  return restPost<EventRecord>(env, accessToken, 'events', data);
}

export function updateEvent(env: SupabaseEnv, accessToken: string, id: string, data: Partial<EventRecord>) {
  return restPatch<EventRecord>(env, accessToken, `events?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteEvent(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `events?id=eq.${encodeURIComponent(id)}`);
}
