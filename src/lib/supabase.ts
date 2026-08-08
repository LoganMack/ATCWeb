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

/**
 * Same as `restGet`, but pages through PostgREST's `Range` header until
 * every row is back, instead of trusting a single response to contain
 * everything. Supabase's hosted API defaults to capping any single
 * response at 1000 rows (project-configurable, but not something this app
 * controls or can assume) — a plain `restGet` on a query that can grow past
 * that (e.g. `src/lib/results.ts`'s career-stats bulk queries, which span
 * every championship season's `race_scores`/`curated_race_results` at
 * once) would silently come back TRUNCATED rather than erroring, which is
 * far worse than a loud failure: every computation built on top of it would
 * just quietly be wrong for whichever rows got cut off.
 *
 * For any query whose result actually stays under one page, this behaves
 * identically to `restGet` (one request, returned as soon as a
 * shorter-than-`pageSize` page comes back) — safe to use as the default for
 * any query without a natural small bound, not just ones already known to
 * be large today.
 */
export async function restGetAll<T>(env: SupabaseEnv, path: string, pageSize = 1000): Promise<T[]> {
  if (!env.url || !env.anonKey) {
    throw new Error('Supabase URL/anon key are not set (checked both the Cloudflare runtime env and import.meta.env).');
  }
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${env.url}/rest/v1/${path}`, {
      headers: { ...restHeaders(env), Range: `${offset}-${offset + pageSize - 1}` },
    });
    // PostgREST returns 206 for a partial page and (in some configurations)
    // 200 when the requested range happens to cover the whole result —
    // both are a successful response here, unlike every other status.
    if (!res.ok && res.status !== 206) {
      throw new Error(`Supabase REST error ${res.status} on ${path}: ${await res.text()}`);
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
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
  /**
   * Entered manually by an admin for now — see 0011_driver_signup_date.sql
   * for what this is eventually meant to power (automatic number release
   * after 90 inactive days, veteran protection, etc.), none of which is
   * built yet.
   */
  sign_up_date: string | null; // 'YYYY-MM-DD'
  /** Rulebook rules 57-62 — see src/lib/penalties.ts's isOnProbationNow() for how these two combine into "currently on probation, yes/no". */
  on_probation: boolean;
  probation_started_at: string | null; // 'YYYY-MM-DD'
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
  /** Optionally links this post to one round's results (curated_rounds.subsession_id) — when set, the article shows a link to that round at the top and a live-computed race recap at the bottom (see src/lib/newsRecap.ts). Deliberately a plain number, no FK — curated_rounds is an external pipeline table this repo's migrations must never touch (0017_news_round_season.sql). */
  round_subsession_id: number | null;
  /** Freeform season tag (e.g. "ATC17", or an exhibition season's own name) — matches the same free-text `season_label` the results pipeline already uses on curated_rounds, NOT a foreign key to `seasons`, specifically so a post can be tagged with any season including non-points ones. Powers the season filter dropdown on /news and the season picker on the post editor (0017_news_round_season.sql). */
  season_label: string | null;
}

/**
 * All drivers, ordered by class rank then car number. Embeds team/status/class
 * names via PostgREST's resource embedding.
 *
 * The `teams!drivers_team_id_fkey` bit (rather than plain `teams(...)`) is
 * required, not stylistic: since 0008_team_rosters.sql added `team_rosters`
 * (a many-to-many join table between drivers and teams, for season-scoped
 * rosters), PostgREST sees *two* possible drivers→teams relationships — the
 * direct `drivers.team_id` FK, and the many-to-many via `team_rosters` — and
 * refuses to guess, failing the whole query with a PGRST201 "more than one
 * relationship was found" error. Naming the FK constraint explicitly tells
 * it to use the direct one (a driver's current team), not the roster table.
 */
export function getDrivers(env: SupabaseEnv) {
  const select =
    'id,car_number,name,is_rookie,car,appearances,starts,seasons_count,' +
    'penalty_points,penalty_points_max,sign_up_date,on_probation,probation_started_at,' +
    'driver_statuses(name),driver_classes(name),teams!drivers_team_id_fkey(name,primary_color_hex,logo_url)';
  return restGet<Driver[]>(
    env,
    `drivers?select=${encodeURIComponent(select)}&order=car_number.asc.nullslast`
  );
}

const NEWS_PUBLIC_SELECT =
  'id,slug,title,excerpt,body,cover_image_url,author_name,published_at,round_subsession_id,season_label';

/** Published news posts, newest first. */
export function getNewsPosts(env: SupabaseEnv, limit?: number) {
  const params = new URLSearchParams({
    select: NEWS_PUBLIC_SELECT,
    order: 'published_at.desc',
  });
  if (limit) params.set('limit', String(limit));
  return restGet<NewsPost[]>(env, `news_posts?${params.toString()}`);
}

/** A single published news post by slug. */
export async function getNewsPostBySlug(env: SupabaseEnv, slug: string) {
  const posts = await restGet<NewsPost[]>(
    env,
    `news_posts?select=${NEWS_PUBLIC_SELECT}&slug=eq.${encodeURIComponent(slug)}&limit=1`
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

// --- Team rosters (season-scoped team membership, max 4 drivers/team/season, see 0008_team_rosters.sql) -

export interface TeamRosterEntry {
  season_id: string;
  team_id: string;
  driver_id: string;
}

const TEAM_ROSTER_SELECT = 'season_id,team_id,driver_id';

/** Every roster entry across every team for one season. */
export function getTeamRosterForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<TeamRosterEntry[]>(
    env,
    `team_rosters?select=${TEAM_ROSTER_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
}

/** One team's roster entries for one season (at most 4, enforced server-side). */
export function getTeamRosterForTeamSeason(env: SupabaseEnv, teamId: string, seasonId: string) {
  return restGet<TeamRosterEntry[]>(
    env,
    `team_rosters?select=${TEAM_ROSTER_SELECT}&team_id=eq.${encodeURIComponent(teamId)}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
}

/** Adds one driver to a team's roster for a season. Throws (with the trigger's own message) if the team's already at 4, or the driver's already on another team that season. */
export function addTeamRosterEntry(env: SupabaseEnv, accessToken: string, data: TeamRosterEntry) {
  return restPost<TeamRosterEntry>(env, accessToken, 'team_rosters', data);
}

export function removeTeamRosterEntry(env: SupabaseEnv, accessToken: string, data: TeamRosterEntry) {
  return restDelete(
    env,
    accessToken,
    `team_rosters?season_id=eq.${encodeURIComponent(data.season_id)}&team_id=eq.${encodeURIComponent(data.team_id)}&driver_id=eq.${encodeURIComponent(data.driver_id)}`
  );
}

// --- Team season logos (historical logos, see 0019_team_season_logos.sql) -

export interface TeamSeasonLogo {
  id: string;
  team_id: string;
  season_id: string;
  logo_url: string;
}

const TEAM_SEASON_LOGO_SELECT = 'id,team_id,season_id,logo_url';

/** One team's historical logo overrides, across every season it has one for — powers the "Historical Logos" list on the admin team edit page. */
export function getTeamSeasonLogosForTeam(env: SupabaseEnv, teamId: string) {
  return restGet<TeamSeasonLogo[]>(
    env,
    `team_season_logos?select=${TEAM_SEASON_LOGO_SELECT}&team_id=eq.${encodeURIComponent(teamId)}`
  );
}

/** Every team's historical logo overrides, across every season — one query to build the season-aware logo lookup src/lib/results.ts's resolveTeamLogo() uses, rather than one query per team or per round. */
export function getAllTeamSeasonLogos(env: SupabaseEnv) {
  return restGet<TeamSeasonLogo[]>(env, `team_season_logos?select=${TEAM_SEASON_LOGO_SELECT}`);
}

/** Upserts the logo for one (team, season) — replaces whatever override was set for that season before, but never touches the team's current logo (teams.logo_url) or any other season's override. */
export async function upsertTeamSeasonLogo(
  env: SupabaseEnv,
  accessToken: string,
  data: { team_id: string; season_id: string; logo_url: string }
) {
  const res = await fetch(`${env.url}/rest/v1/team_season_logos?on_conflict=team_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on team_season_logos: ${await res.text()}`);
  const rows = (await res.json()) as TeamSeasonLogo[];
  return rows[0];
}

export function deleteTeamSeasonLogo(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `team_season_logos?id=eq.${encodeURIComponent(id)}`);
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
  sign_up_date: string | null; // 'YYYY-MM-DD'
  on_probation: boolean;
  probation_started_at: string | null; // 'YYYY-MM-DD'
}

const DRIVER_ADMIN_SELECT =
  'id,car_number,name,status_id,class_id,team_id,is_rookie,car,appearances,starts,' +
  'seasons_count,penalty_points,penalty_points_max,photo_url,bio,sign_up_date,on_probation,probation_started_at';

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

export interface DriverOption {
  id: string;
  name: string;
  car_number: number | null;
}

/** Lean id/name/number list for admin dropdowns (e.g. picking a driver to add to a team's season roster). */
export function getDriversBasic(env: SupabaseEnv) {
  return restGet<DriverOption[]>(env, 'drivers?select=id,name,car_number&order=name.asc');
}

// --- News (admin) ------------------------------------------------------

export interface NewsPostAdmin extends NewsPost {
  status: 'draft' | 'published';
}

const NEWS_ADMIN_SELECT =
  'id,slug,title,excerpt,body,cover_image_url,author_name,status,published_at,round_subsession_id,season_label';

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

// --- Round overrides (flag an individual round as a non-points exhibition) -

export interface RoundOverride {
  subsession_id: number;
  is_exhibition: boolean;
  note: string | null;
}

const ROUND_OVERRIDE_SELECT = 'subsession_id,is_exhibition,note';

/** subsession_ids flagged as a non-points exhibition — used to exclude those rounds from standings/champions even inside an otherwise-real championship season. */
export async function getExhibitionRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  const rows = await restGet<{ subsession_id: number }[]>(
    env,
    'round_overrides?select=subsession_id&is_exhibition=eq.true'
  );
  return new Set(rows.map((r) => r.subsession_id));
}

export async function getRoundOverride(env: SupabaseEnv, subsessionId: number) {
  const rows = await restGet<RoundOverride[]>(
    env,
    `round_overrides?select=${ROUND_OVERRIDE_SELECT}&subsession_id=eq.${subsessionId}`
  );
  return rows[0] ?? null;
}

/** Marks (or unmarks) one round as a non-points exhibition — upserts on subsession_id. */
export async function setRoundExhibition(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number,
  isExhibition: boolean
) {
  const res = await fetch(`${env.url}/rest/v1/round_overrides?on_conflict=subsession_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify({ subsession_id: subsessionId, is_exhibition: isExhibition }),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on round_overrides: ${await res.text()}`);
  const rows = (await res.json()) as RoundOverride[];
  return rows[0];
}

// --- Race links (iRacing results / replay download / broadcast video, per race) -

export interface RaceLinks {
  subsession_id: number;
  race_number: number;
  iracing_subsession_id: number | null;
  replay_url: string | null;
  broadcast_url: string | null;
  /** The stewards' published incident report for this round (rule 51) — usually applies to the whole round rather than one specific race, but lives here since race_links is already the per-race external-link table and a round only rarely splits its report by race. */
  incident_report_url: string | null;
  /** Wherever the series photographer's album for this specific race lives (0025_race_links_photo_album.sql) — e.g. a Flickr album. */
  photo_album_url: string | null;
}

const RACE_LINKS_SELECT =
  'subsession_id,race_number,iracing_subsession_id,replay_url,broadcast_url,incident_report_url,photo_album_url';

/** Every race's links for one round, keyed by race_number. */
export async function getRaceLinksForSubsession(env: SupabaseEnv, subsessionId: number): Promise<Map<number, RaceLinks>> {
  const rows = await restGet<RaceLinks[]>(
    env,
    `race_links?select=${RACE_LINKS_SELECT}&subsession_id=eq.${subsessionId}`
  );
  return new Map(rows.map((r) => [r.race_number, r]));
}

/** Upserts one race's links — replaces whatever was set for that (subsession_id, race_number) before. Any field left undefined stays whatever it already was; pass null explicitly to clear a field. */
export async function upsertRaceLinks(
  env: SupabaseEnv,
  accessToken: string,
  data: {
    subsession_id: number;
    race_number: number;
    iracing_subsession_id?: number | null;
    replay_url?: string | null;
    broadcast_url?: string | null;
    incident_report_url?: string | null;
    photo_album_url?: string | null;
  }
) {
  const res = await fetch(`${env.url}/rest/v1/race_links?on_conflict=subsession_id,race_number`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on race_links: ${await res.text()}`);
  const rows = (await res.json()) as RaceLinks[];
  return rows[0];
}

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

// --- Page banners (see 0024_season_logos_and_page_banners.sql) -----------
//
// One optional background image per public page, keyed by a stable
// `page_key` the app itself defines (see src/lib/pageBanners.ts for the
// full list) — not a foreign key to anything, just a natural key like
// car_logos' car_name. A page with no row here renders with no banner
// (plain black, matching the site's dark background — see PageBanner.astro
// and the homepage hero for how each renders that "nothing configured"
// state).

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

// --- Storage (team logos, driver photos, page banners) -------------------

/**
 * Uploads a file to a public Storage bucket and returns its public URL.
 * `x-upsert: true` lets re-uploading to the same path (e.g. replacing a
 * team's logo) overwrite in place instead of erroring.
 */
export async function uploadToStorage(
  env: SupabaseEnv,
  accessToken: string,
  bucket: 'logos' | 'photos' | 'banners',
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

/** Sets (or clears, with `null`) a season's logo — the only field seasons can be admin-edited from (0024_season_logos_and_page_banners.sql). */
export async function updateSeasonLogo(env: SupabaseEnv, accessToken: string, id: string, logoUrl: string | null) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, { logo_url: logoUrl });
}

/**
 * Marks one season as the current one (is_current=true), the season the
 * public site's pickers default to (see standings.astro/team-standings.astro/
 * results.astro all falling back to `seasons.find((s) => s.is_current)`).
 * `seasons` has a partial unique index enforcing at most one is_current=true
 * row at a time (0001_init.sql) — so the old current season has to be
 * cleared to false FIRST, then the new one set to true, or the second PATCH
 * would violate that index while the old row is still true. Two requests,
 * not a transaction, since PostgREST doesn't expose one for plain REST
 * calls — a failure between them would leave no season marked current
 * rather than two, which is the safer of the two ways this could go wrong.
 */
export async function setCurrentSeason(env: SupabaseEnv, accessToken: string, seasonId: string) {
  await restPatch<Season>(env, accessToken, `seasons?is_current=eq.true&id=neq.${encodeURIComponent(seasonId)}`, {
    is_current: false,
  });
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(seasonId)}`, { is_current: true });
}

// ---------------------------------------------------------------------------
// CALENDAR — circuits + events
// ---------------------------------------------------------------------------

// --- Circuits ------------------------------------------------------------

export interface Circuit {
  id: string;
  name: string;
  logo_url: string | null;
  location: string | null;
}

const CIRCUIT_SELECT = 'id,name,logo_url,location';

export function getCircuits(env: SupabaseEnv) {
  return restGet<Circuit[]>(env, `circuits?select=${CIRCUIT_SELECT}&order=name.asc`);
}

export async function getCircuitById(env: SupabaseEnv, id: string) {
  const circuits = await restGet<Circuit[]>(
    env,
    `circuits?select=${CIRCUIT_SELECT}&id=eq.${encodeURIComponent(id)}`
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

// --- Circuit layouts (lap records, see 0010_circuit_layouts.sql) -----------

export interface CircuitLayout {
  id: string;
  circuit_id: string;
  name: string;
  length_km: number | null;
  /** Raw seconds, to the nearest thousandth (e.g. 102.512) — as imported. Use `formatLapTime()` to display it as "01:42.512". */
  lap_record_seconds: number | null;
  lap_record_holder: string | null;
  lap_record_date: string | null; // 'YYYY-MM-DD'
  /** This specific layout's own image (e.g. its track map) — see 0021_circuit_layout_image.sql. Falls back to the parent circuit's logo_url when null; use `layoutImageUrl()`. */
  image_url: string | null;
  /** Number of corners on this layout, admin-entered — see 0022_circuit_layout_corners.sql. Powers the Standings page's season "corners per incident" stat (src/lib/results.ts's getSeasonDriverExtendedStats); null until Logan fills it in for a given layout. */
  corners: number | null;
}

const CIRCUIT_LAYOUT_SELECT = 'id,circuit_id,name,length_km,lap_record_seconds,lap_record_holder,lap_record_date,image_url,corners';

/** "1:42.512" from a raw seconds count (e.g. 102.512) — minutes are shown with no leading zero (per site-wide convention: no leading zeroes on lap records/times), while seconds/milliseconds keep their own fixed-width zero-padding since those are always exactly 2 and 3 digits within a minute. */
export function formatLapTime(seconds: number | null): string {
  if (seconds === null) return '—';
  const totalMs = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * "Full Course" from the "N/A" sentinel some circuit layouts are stored
 * with (used when a circuit only has one configuration and no specific
 * layout name applies) — display-only, doesn't touch the stored value.
 */
export function displayLayoutName(name: string): string {
  return name === 'N/A' ? 'Full Course' : name;
}

/** A layout's own image if it has one on file, otherwise the parent circuit's shared logo (or null if neither exists). */
export function layoutImageUrl(layout: Pick<CircuitLayout, 'image_url'>, circuit: Pick<Circuit, 'logo_url'> | null): string | null {
  return layout.image_url ?? circuit?.logo_url ?? null;
}

/**
 * "Chris Macdonald" from "Chris Macdonald5" — iRacing appends a trailing
 * number directly to a driver's name to disambiguate real-name duplicates
 * on the roster (see 0001_init.sql's `name` column comment). Display-only:
 * never use this to write back to the stored `name` value, since the
 * driver record needs to keep the exact iRacing-supplied name to stay
 * aligned with iRacing (and unique in the database).
 */
export function displayDriverName(name: string): string {
  return name.replace(/\d+$/, '');
}

/**
 * "August 5, 2026" — the one date format used everywhere across the site,
 * from a 'YYYY-MM-DD' date-only string or a full ISO timestamp.
 * Date-only strings are parsed as local calendar-date components rather
 * than handed straight to `new Date()`, which treats a bare 'YYYY-MM-DD'
 * as UTC midnight and can render as the *previous* day once
 * `toLocaleDateString` applies a negative-offset local timezone.
 */
export function formatDate(dateInput: string | null): string {
  if (!dateInput) return '—';
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  const date = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(dateInput);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function getCircuitLayouts(env: SupabaseEnv, circuitId: string) {
  return restGet<CircuitLayout[]>(
    env,
    `circuit_layouts?select=${CIRCUIT_LAYOUT_SELECT}&circuit_id=eq.${encodeURIComponent(circuitId)}&order=name.asc`
  );
}

/** Every layout for every circuit in one query — powers the public Circuits page, which needs all of them up front rather than one request per circuit. */
export function getAllCircuitLayouts(env: SupabaseEnv) {
  return restGet<CircuitLayout[]>(env, `circuit_layouts?select=${CIRCUIT_LAYOUT_SELECT}&order=circuit_id.asc,name.asc`);
}

export function createCircuitLayout(env: SupabaseEnv, accessToken: string, data: Partial<CircuitLayout>) {
  return restPost<CircuitLayout>(env, accessToken, 'circuit_layouts', data);
}

export function updateCircuitLayout(env: SupabaseEnv, accessToken: string, id: string, data: Partial<CircuitLayout>) {
  return restPatch<CircuitLayout>(env, accessToken, `circuit_layouts?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteCircuitLayout(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `circuit_layouts?id=eq.${encodeURIComponent(id)}`);
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
  /** In-sim time of day for this session (0023_event_sim_times.sql) — a separate concept from practice_start_time above (that's the real-world/local clock time people need to show up; this is what iRacing's own clock is set to, affecting lighting/weather progression). Same 'HH:MM:SS' shape, no timezone (a sim clock has none). */
  practice_sim_time: string | null;
  practice_minutes: number | null;
  practice_weather: Weather | null;

  qualifying_start_time: string | null;
  qualifying_sim_time: string | null;
  qualifying_minutes: number | null;
  qualifying_laps: number | null;
  qualifying_weather: Weather | null;

  race1_start_time: string;
  race1_sim_time: string | null;
  race1_laps: number | null;
  race1_weather: Weather | null;

  race2_start_time: string | null;
  race2_sim_time: string | null;
  race2_laps: number | null;
  race2_weather: Weather | null;

  race3_start_time: string | null;
  race3_sim_time: string | null;
  race3_laps: number | null;
  race3_weather: Weather | null;
}

export interface EventWithCircuit extends EventRecord {
  circuits: { name: string; logo_url: string | null } | null;
}

const EVENT_SELECT =
  'id,circuit_id,layout,event_date,format,fuel_limit_pct,results_url,' +
  'practice_start_time,practice_sim_time,practice_minutes,practice_weather,' +
  'qualifying_start_time,qualifying_sim_time,qualifying_minutes,qualifying_laps,qualifying_weather,' +
  'race1_start_time,race1_sim_time,race1_laps,race1_weather,' +
  'race2_start_time,race2_sim_time,race2_laps,race2_weather,' +
  'race3_start_time,race3_sim_time,race3_laps,race3_weather';

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

// ---------------------------------------------------------------------------
// PENALTIES (rulebook 18.3, section 5 "Stewarding") — see 0014_penalties.sql
// and src/lib/penalties.ts (the position/points recalculation engine, which
// consumes the Penalty type below).
// ---------------------------------------------------------------------------

export interface PenaltyOffense {
  id: string;
  name: string;
  /** Free text (e.g. "1-4", "Warning or 1") — see 0014_penalties.sql for why this isn't a plain number. Reference only; never auto-summed into a penalty's actual penalty_points. */
  reference_points: string | null;
  sort_order: number;
}

const PENALTY_OFFENSE_SELECT = 'id,name,reference_points,sort_order';

export function getPenaltyOffenses(env: SupabaseEnv) {
  return restGet<PenaltyOffense[]>(env, `penalty_offenses?select=${PENALTY_OFFENSE_SELECT}&order=sort_order.asc`);
}

export function createPenaltyOffense(env: SupabaseEnv, accessToken: string, data: Partial<PenaltyOffense>) {
  return restPost<PenaltyOffense>(env, accessToken, 'penalty_offenses', data);
}

export function updatePenaltyOffense(env: SupabaseEnv, accessToken: string, id: string, data: Partial<PenaltyOffense>) {
  return restPatch<PenaltyOffense>(env, accessToken, `penalty_offenses?id=eq.${encodeURIComponent(id)}`, data);
}

export function deletePenaltyOffense(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `penalty_offenses?id=eq.${encodeURIComponent(id)}`);
}

export interface Penalty {
  id: string;
  subsession_id: number;
  race_number: number;
  /** Null means "Racing Incident" — reviewed and judged nobody's fault, so no driver is attached (0020_penalty_racing_incident.sql). Shown as "RI" in the Incident Report's Driver column instead of a car number, and never affects anyone's position/points — the recalculation engine keys everything off driver_id, so a row with none can't touch any driver's result. */
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  /** Flags this as (also, or only) a warning — rulebook offense "2 warnings" escalates to +1 PP, so stewards need to see how many a driver already has (see getWarningCounts) before logging a third. Doesn't change how the penalty's own time/points/PP fields are applied — a warning can still carry a real PP value if the steward enters one. */
  is_warning: boolean;
  created_at: string;
  /** Every offense tagged on this penalty — descriptive/record-keeping only, doesn't drive any of the math (see penalty_points above). */
  offense_ids: string[];
  /** Other drivers' cars that were part of the same incident — descriptive only, same as offense_ids. */
  involved_driver_ids: string[];
  /**
   * Appeal fields (0016_penalty_appeals.sql). Once is_appealed is set, every
   * place src/lib/penalties.ts reads this penalty's time/points/PP uses the
   * appeal_* values instead of the original ones (see its effective* helpers)
   * — the original fields stay put as a record of what was first logged.
   * appeal_result is a free-text ruling ("Upheld", "Reduced to 5s", etc.),
   * shown alongside the penalty but not itself consumed by any calculation.
   */
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

interface PenaltyRow {
  id: string;
  subsession_id: number;
  race_number: number;
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_warning: boolean;
  created_at: string;
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
  penalty_offense_links: { offense_id: string }[];
  penalty_involved_drivers: { driver_id: string }[];
}

const PENALTY_SELECT =
  'id,subsession_id,race_number,driver_id,incident_number,lap,description,' +
  'time_penalty_seconds,points_penalty,penalty_points,is_warning,created_at,' +
  'is_appealed,appeal_result,appeal_time_penalty_seconds,appeal_points_penalty,appeal_penalty_points,' +
  'penalty_offense_links(offense_id),penalty_involved_drivers(driver_id)';

function toPenalty(row: PenaltyRow): Penalty {
  const { penalty_offense_links, penalty_involved_drivers, ...rest } = row;
  return {
    ...rest,
    offense_ids: penalty_offense_links.map((l) => l.offense_id),
    involved_driver_ids: penalty_involved_drivers.map((l) => l.driver_id),
  };
}

/** Every penalty logged against any race in one round, oldest first (so later penalties, if any ever stack for the same driver+race, apply in the order they were issued). */
export async function getPenaltiesForSubsession(env: SupabaseEnv, subsessionId: number): Promise<Penalty[]> {
  const rows = await restGet<PenaltyRow[]>(
    env,
    `penalties?select=${encodeURIComponent(PENALTY_SELECT)}&subsession_id=eq.${subsessionId}&order=created_at.asc`
  );
  return rows.map(toPenalty);
}

/**
 * Every penalty logged against any of the given rounds, oldest first — the
 * bulk version of getPenaltiesForSubsession, used wherever a whole season
 * (not just one round) needs to be recalculated: season standings
 * (src/lib/results.ts) and a driver's season-scoped PP/warning tally (see
 * computeSeasonPPState/countWarnings in src/lib/penalties.ts). Returns an
 * empty list (no query) for an empty input, since PostgREST's `in.()` with
 * nothing inside it isn't a meaningful filter.
 */
export async function getPenaltiesForSubsessions(env: SupabaseEnv, subsessionIds: number[]): Promise<Penalty[]> {
  if (subsessionIds.length === 0) return [];
  // restGetAll (not restGet) — a whole-career query (src/lib/results.ts's
  // computeDriverCareerStats) can span hundreds of rounds across every
  // season at once, and a plain restGet would silently truncate at
  // Supabase's default 1000-row response cap instead of erroring. See
  // restGetAll's own doc comment.
  const rows = await restGetAll<PenaltyRow>(
    env,
    `penalties?select=${encodeURIComponent(PENALTY_SELECT)}&subsession_id=in.(${subsessionIds.join(',')})&order=created_at.asc`
  );
  return rows.map(toPenalty);
}

export interface PenaltyInput {
  subsession_id: number;
  race_number: number;
  /** Null for a Racing Incident (no driver at fault) — see Penalty.driver_id's own doc comment. */
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_warning: boolean;
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

/** Inserts a penalty and links it to every selected offense/involved driver — three REST calls, not a real transaction (this backend is plain PostgREST, no server-side function for this yet), so a failure partway through can in principle leave a penalty with no tags/involved cars linked. Acceptable for now: the penalty's own time/points/PP fields (the numbers that actually drive recalculation) are set atomically on the first insert either way. */
export async function createPenalty(
  env: SupabaseEnv,
  accessToken: string,
  data: PenaltyInput,
  offenseIds: string[],
  involvedDriverIds: string[]
): Promise<Penalty> {
  const created = await restPost<PenaltyRow>(env, accessToken, 'penalties', data);
  if (offenseIds.length > 0) {
    await restPost(env, accessToken, 'penalty_offense_links', offenseIds.map((offense_id) => ({ penalty_id: created.id, offense_id })));
  }
  if (involvedDriverIds.length > 0) {
    await restPost(env, accessToken, 'penalty_involved_drivers', involvedDriverIds.map((driver_id) => ({ penalty_id: created.id, driver_id })));
  }
  return { ...created, offense_ids: offenseIds, involved_driver_ids: involvedDriverIds };
}

/**
 * Updates a penalty's own fields, then replaces its offense/involved-driver
 * links wholesale (delete everything currently linked, insert the new
 * selection) rather than trying to diff them — simplest correct way to
 * handle a checkbox list that can add and remove entries in the same edit.
 * Unlike in v0.13/v0.14, editing a penalty's PP (or its own is_appealed
 * override) DOES now ripple through to the driver's season PP tally — the
 * caller (src/pages/results/[subsessionId].astro) re-runs
 * computeSeasonPPState over the driver's whole season after every mutation
 * rather than incrementally patching a stored counter, so there's no
 * separate "retroactive adjustment" step needed here.
 */
export async function updatePenalty(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<PenaltyInput>,
  offenseIds: string[],
  involvedDriverIds: string[]
): Promise<void> {
  await restPatch<PenaltyRow>(env, accessToken, `penalties?id=eq.${encodeURIComponent(id)}`, data);
  await restDelete(env, accessToken, `penalty_offense_links?penalty_id=eq.${encodeURIComponent(id)}`);
  await restDelete(env, accessToken, `penalty_involved_drivers?penalty_id=eq.${encodeURIComponent(id)}`);
  if (offenseIds.length > 0) {
    await restPost(env, accessToken, 'penalty_offense_links', offenseIds.map((offense_id) => ({ penalty_id: id, offense_id })));
  }
  if (involvedDriverIds.length > 0) {
    await restPost(env, accessToken, 'penalty_involved_drivers', involvedDriverIds.map((driver_id) => ({ penalty_id: id, driver_id })));
  }
}

/** Removes a penalty (its offense/involved-driver links cascade). Same as updatePenalty (see its doc comment): the caller re-recomputes the driver's season PP tally from scratch afterward, so a deleted penalty's PP correctly stops counting without any manual correction. */
export function deletePenalty(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `penalties?id=eq.${encodeURIComponent(id)}`);
}

/**
 * driver_id -> how many warnings (is_warning penalties) they have, scoped to
 * whichever subsession IDs the caller passes in — pass the current season's
 * round subsession_ids (see getCurrentSeasonRounds in src/lib/results.ts) to
 * get a season-scoped count, per Logan: "Warnings should be season-scoped,
 * not career-scoped." Used to surface "this driver has already been warned
 * N times this season" while logging a new penalty.
 */
export async function getWarningCounts(env: SupabaseEnv, subsessionIds: number[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subsessionIds.length === 0) return out;
  const rows = await restGet<{ driver_id: string | null }[]>(
    env,
    `penalties?select=driver_id&is_warning=eq.true&subsession_id=in.(${subsessionIds.join(',')})`
  );
  // A Racing Incident (driver_id null) is never a warning in practice — the
  // add/edit dialog hides that checkbox once "Racing Incident" is selected
  // — but guard anyway rather than let a null slip into the map's keys.
  for (const r of rows) {
    if (!r.driver_id) continue;
    out.set(r.driver_id, (out.get(r.driver_id) ?? 0) + 1);
  }
  return out;
}
