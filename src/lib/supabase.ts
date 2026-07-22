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

async function restGet<T>(env: SupabaseEnv, path: string): Promise<T> {
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
