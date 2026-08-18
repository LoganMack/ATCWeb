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
  /** ISO 3166-1 alpha-2 codes (lowercase), 0029_driver_nationality.sql — see src/components/DriverFlag.astro. */
  nationality_1: string | null;
  nationality_2: string | null;
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
    'penalty_points,penalty_points_max,sign_up_date,on_probation,probation_started_at,nationality_1,nationality_2,' +
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

// restGetAuthed/restPost/restPatch/restDelete are exported (same reasoning
// as restGet/restGetAll above) so src/lib/raceResultsImport.ts can write
// directly into curated_rounds/curated_race_results/race_scores — tables
// this file's usual per-table CRUD pattern deliberately never touches (see
// that file's own header comment for why that boundary is broken there,
// specifically, as a one-off approved exception).
export async function restGetAuthed<T>(env: SupabaseEnv, accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, { headers: writeHeaders(env, accessToken) });
  if (!res.ok) throw new Error(`Supabase REST error ${res.status} on ${path}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function restPost<T>(env: SupabaseEnv, accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase insert error ${res.status} on ${path}: ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0];
}

export async function restPatch<T>(env: SupabaseEnv, accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase update error ${res.status} on ${path}: ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0];
}

export async function restDelete(env: SupabaseEnv, accessToken: string, path: string): Promise<void> {
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

// --- Organizations (persistent identity across team renames, see 0043_organizations.sql) -

export interface Organization {
  id: string;
  name: string;
}

export interface OrganizationTeamSeason {
  id: string;
  organization_id: string;
  team_id: string;
  season_id: string;
}

export function getOrganizations(env: SupabaseEnv) {
  return restGet<Organization[]>(env, 'organizations?select=id,name&order=name.asc');
}

export async function getOrganizationById(env: SupabaseEnv, id: string) {
  const orgs = await restGet<Organization[]>(env, `organizations?select=id,name&id=eq.${encodeURIComponent(id)}`);
  return orgs[0] ?? null;
}

/** Every organization<->team season link, across every org — computeTeamCareerStats (src/lib/results.ts) fetches this once and builds a team+season -> organization lookup from it, rather than querying per-organization. */
export function getAllOrganizationTeamSeasons(env: SupabaseEnv) {
  return restGet<OrganizationTeamSeason[]>(env, 'organization_team_seasons?select=id,organization_id,team_id,season_id');
}

export function getOrganizationTeamSeasons(env: SupabaseEnv, organizationId: string) {
  return restGet<OrganizationTeamSeason[]>(
    env,
    `organization_team_seasons?select=id,organization_id,team_id,season_id&organization_id=eq.${encodeURIComponent(organizationId)}`
  );
}

export function createOrganization(env: SupabaseEnv, accessToken: string, data: { name: string }) {
  return restPost<Organization>(env, accessToken, 'organizations', data);
}

export function updateOrganization(env: SupabaseEnv, accessToken: string, id: string, data: { name: string }) {
  return restPatch<Organization>(env, accessToken, `organizations?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteOrganization(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `organizations?id=eq.${encodeURIComponent(id)}`);
}

/**
 * Sets (or clears) which team represents an organization for one season.
 * Both uniqueness rules (one team per org per season, one org per team per
 * season — see 0043_organizations.sql) mean this can't be a plain upsert:
 * assigning a team here first has to release any existing claim on that
 * exact (org, season) slot AND any existing claim another org has on that
 * exact (team, season) pair, before inserting the new link. Passing
 * `teamId: null` just clears this org's slot for that season without
 * creating a new link.
 */
export async function setOrganizationTeamForSeason(
  env: SupabaseEnv,
  accessToken: string,
  organizationId: string,
  seasonId: string,
  teamId: string | null
) {
  await restDelete(
    env,
    accessToken,
    `organization_team_seasons?organization_id=eq.${encodeURIComponent(organizationId)}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
  if (!teamId) return;
  await restDelete(
    env,
    accessToken,
    `organization_team_seasons?team_id=eq.${encodeURIComponent(teamId)}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
  await restPost<OrganizationTeamSeason>(env, accessToken, 'organization_team_seasons', {
    organization_id: organizationId,
    team_id: teamId,
    season_id: seasonId,
  });
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

/** One team's historical logo overrides, across every season it has one for — powers the "Logos by Season" list on the admin team edit page. */
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
  /**
   * Their iRacing customer id — the ONLY thing that links this drivers row
   * to their actual race results (curated_race_results.cust_id,
   * recalculate_race_scores()'s entrant join, driver_last_race — see those
   * for the full list). Added to `drivers` outside this repo's migrations
   * (see 0005_round_overrides.sql's grant-fix note), and until now had no
   * admin UI field at all despite raceResultsImport.ts's own doc comment
   * telling admins to "set it first on their Roster profile" — the Sync
   * Results with Roster button (src/lib/raceResultsImport.ts's
   * syncResultsWithRoster) is what actually needs this field editable, so
   * a driver it links (rather than creates fresh) can be corrected by hand
   * afterward, and so an admin can fix a genuine mismatch without a direct
   * database edit.
   */
  iracing_cust_id: number | null;
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
  /** 0027_hall_of_fame.sql — toggled by an admin, powers the public /hall-of-fame page. See getHallOfFameDrivers(). */
  is_hall_of_fame: boolean;
  /** ISO 3166-1 alpha-2 codes (lowercase), 0029_driver_nationality.sql — see src/components/DriverFlag.astro. */
  nationality_1: string | null;
  nationality_2: string | null;
  /** iRating when this driver joined ATC — reference only, not validated against iRacing's real range. 0039_driver_admin_overhaul.sql. */
  starting_irating: number | null;
  created_at: string;
  updated_at: string;
  /** auth.users.id of whoever created/most-recently-touched this row — auto-stamped by the drivers_set_audit_fields trigger, never sent by the app. 0039_driver_admin_overhaul.sql. */
  created_by: string | null;
  updated_by: string | null;
}

const DRIVER_ADMIN_SELECT =
  'id,car_number,name,status_id,class_id,team_id,iracing_cust_id,is_rookie,car,appearances,starts,' +
  'seasons_count,penalty_points,penalty_points_max,photo_url,bio,sign_up_date,on_probation,probation_started_at,is_hall_of_fame,' +
  'nationality_1,nationality_2,starting_irating,created_at,updated_at,created_by,updated_by';

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

/** Lean lookup for the admin driver edit page's live "is this number taken?" check — every driver with a car_number set, plus enough to explain who holds it. Fetched once and matched client-side as the admin types, rather than a round trip per keystroke. */
export interface DriverNumberLookup {
  id: string;
  name: string;
  car_number: number;
  driver_statuses: { name: string } | null;
}

export function getDriversForNumberCheck(env: SupabaseEnv) {
  return restGet<DriverNumberLookup[]>(
    env,
    'drivers?select=id,name,car_number,driver_statuses(name)&car_number=not.is.null'
  );
}

/** Every driver who already has an iRacing Customer ID set — used both by the admin driver edit page's "is this cust_id already claimed by someone else?" check (see readForm/the save handler in admin/drivers/[id].astro) and by raceResultsImport.ts's syncResultsWithRoster, which must never link a cust_id to more than one drivers row (recalculate_race_scores() joins on this column — a duplicate would double-count that one raw result). */
export interface DriverCustIdLookup {
  id: string;
  name: string;
  iracing_cust_id: number | null;
}

export function getDriversForCustIdCheck(env: SupabaseEnv) {
  return restGet<DriverCustIdLookup[]>(env, 'drivers?select=id,name,iracing_cust_id&iracing_cust_id=not.is.null');
}

/** Every driver's most recent race, plus how many official league rounds have run since then (league-wide, not season/class-scoped) — see driver_last_race (0039_driver_admin_overhaul.sql, revised by 0040_inactivity_90d_or_12_rounds.sql). rounds_since_last_race is null exactly when last_race_at is null (never raced / no iracing_cust_id). Powers both sync_driver_statuses() and the admin edit page's inactivity note — a driver goes Inactive once BOTH the configured inactivity-days and inactivity-rounds thresholds have passed since last_race_at (whichever takes longer — see 0041_driver_settings.sql). */
export interface DriverLastRace {
  last_race_at: string | null;
  rounds_since_last_race: number | null;
}

export async function getDriverLastRace(env: SupabaseEnv, driverId: string): Promise<DriverLastRace> {
  const rows = await restGet<DriverLastRace[]>(
    env,
    `driver_last_race?select=last_race_at,rounds_since_last_race&driver_id=eq.${encodeURIComponent(driverId)}`
  );
  return rows[0] ?? { last_race_at: null, rounds_since_last_race: null };
}

/**
 * The ONLY path for changing a driver's car_number — enforces Logan's rule
 * (block if held by anyone not Inactive; silently free it up if the holder
 * IS Inactive) inside one DB transaction via set_driver_car_number()
 * (0039_driver_admin_overhaul.sql), so the two writes involved (freeing the
 * old holder, assigning the new one) can never leave two drivers sharing a
 * number even momentarily. Throws with a message fit to show directly to
 * the admin (e.g. "Car #7 is already in use by Jane Doe (Active)") when the
 * number is taken by anyone not Inactive.
 */
export async function setDriverCarNumber(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
  carNumber: number | null
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/set_driver_car_number`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify({ p_driver_id: driverId, p_car_number: carNumber }),
  });
  if (!res.ok) throw new Error(await res.text());
}

/**
 * Re-derives every driver's status from race activity — see
 * sync_driver_statuses() (0039_driver_admin_overhaul.sql, threshold made
 * dual day/round by 0040_inactivity_90d_or_12_rounds.sql, both thresholds
 * made admin-configurable via site_settings by 0041_driver_settings.sql)
 * for the exact rule (New/Active -> Inactive once BOTH the configured
 * inactivity-days and inactivity-rounds have passed since their last race;
 * Inactive -> Active on return; Veteran untouched). Status editing was
 * removed from the admin driver form entirely per Logan ("that should all
 * be automatic") — this is what keeps status current instead, called
 * opportunistically whenever an admin loads the Drivers pages (this app has
 * no cron/scheduled-worker infrastructure to run it on a real timer).
 * Returns how many rows changed.
 */
export async function syncDriverStatuses(env: SupabaseEnv, accessToken: string): Promise<number> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_driver_statuses`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as number;
}

/**
 * Re-derives is_rookie from career history — see sync_rookie_status()
 * (0041_driver_settings.sql). Once a driver reaches 3+ appearances in a
 * single season, they lose rookie status for good (this only ever flips
 * true -> false, never back). Rookie status is no longer admin-editable —
 * every new driver starts as a rookie (see createDriver's is_rookie: true
 * caller in the admin form) and this is what turns it off automatically.
 * Same opportunistic-call pattern as syncDriverStatuses. Returns how many
 * rows changed.
 */
export async function syncRookieStatus(env: SupabaseEnv, accessToken: string): Promise<number> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_rookie_status`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as number;
}

export interface SyncResultsWithRosterOutcome {
  /** Newly created drivers rows — see sync_results_with_roster() for the full rule. */
  created: string[];
  /** Existing drivers rows that just had their iracing_cust_id filled in. */
  linked: string[];
}

/**
 * Admin > Drivers "Sync Results with Roster" button. Every cust_id that
 * raced in a real (non-exhibition) round but has no matching drivers row —
 * see results.ts's RaceResultRow.notInRoster for the front-end symptom this
 * fixes — either gets linked onto an existing same-named driver who has no
 * cust_id yet, or a new minimal drivers row is created for it.
 *
 * Deliberately a single RPC call (same opportunistic-automation pattern as
 * syncDriverStatuses/syncRookieStatus above) rather than doing the lookup
 * and per-driver creates/updates from the Worker: an earlier version did
 * exactly that and could burn through dozens to hundreds of subrequests in
 * one click (paging through all of curated_race_results, then one REST call
 * per driver touched), which is exactly what tripped Cloudflare's
 * per-invocation subrequest limit in production. See
 * sync_results_with_roster() (0047_sync_results_with_roster.sql) for the
 * actual logic — it also excludes exhibition rounds/seasons there (Logan:
 * "sometimes those include AI drivers"), which the original version never
 * did at all.
 */
export async function syncResultsWithRoster(env: SupabaseEnv, accessToken: string): Promise<SyncResultsWithRosterOutcome> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_results_with_roster`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as SyncResultsWithRosterOutcome;
}

export function deleteDriver(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `drivers?id=eq.${encodeURIComponent(id)}`);
}

// --- Driver season classes (per-season class override, see 0037_class_and_scoring_fixes.sql) -

export interface DriverSeasonClass {
  driver_id: string;
  season_id: string;
  class_id: number;
}

const DRIVER_SEASON_CLASS_SELECT = 'driver_id,season_id,class_id';

/** One driver's per-season class overrides — powers the "Driver Class by Season" list on the admin driver edit page. A season with no row here falls back to the driver's primary class (drivers.class_id) — same fallback scoring itself uses (see recalculate_race_scores in 0037_class_and_scoring_fixes.sql). */
export function getDriverSeasonClassesForDriver(env: SupabaseEnv, driverId: string) {
  return restGet<DriverSeasonClass[]>(
    env,
    `driver_season_classes?select=${DRIVER_SEASON_CLASS_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}`
  );
}

/** Upserts a driver's class for one season — replaces whatever was set for that season before. The table's primary key is (driver_id, season_id), so this can never leave a driver with two classes in the same season. */
export async function upsertDriverSeasonClass(env: SupabaseEnv, accessToken: string, data: DriverSeasonClass) {
  const res = await fetch(`${env.url}/rest/v1/driver_season_classes?on_conflict=driver_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on driver_season_classes: ${await res.text()}`);
  const rows = (await res.json()) as DriverSeasonClass[];
  return rows[0];
}

/** Clears a driver's class override for one season — they fall back to their primary class for that season again. */
export function deleteDriverSeasonClass(env: SupabaseEnv, accessToken: string, driverId: string, seasonId: string) {
  return restDelete(
    env,
    accessToken,
    `driver_season_classes?driver_id=eq.${encodeURIComponent(driverId)}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
}

// --- Driver season car numbers (per-season number override, see 0044_driver_season_car_numbers.sql) -

export interface DriverSeasonCarNumber {
  driver_id: string;
  season_id: string;
  car_number: number;
}

const DRIVER_SEASON_CAR_NUMBER_SELECT = 'driver_id,season_id,car_number';

/** One driver's per-season car number overrides — powers the "Driver Number by Season" list on the admin driver edit page. A season with no row here falls back to the driver's current number (drivers.car_number). */
export function getDriverSeasonCarNumbersForDriver(env: SupabaseEnv, driverId: string) {
  return restGet<DriverSeasonCarNumber[]>(
    env,
    `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}`
  );
}

/** Every driver's number override for one season — used by the admin edit page to validate a new number isn't already claimed by someone else that season. */
export function getDriverSeasonCarNumbersForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<DriverSeasonCarNumber[]>(
    env,
    `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
}

/** Every driver_season_car_numbers row, across every season — the manual Race Results and Incident Report CSV importers fetch this once (rather than per-round-season) to resolve a CSV row's car number to a driver_id for that round's own season, before falling back to drivers.car_number. */
export function getAllDriverSeasonCarNumbers(env: SupabaseEnv) {
  return restGet<DriverSeasonCarNumber[]>(env, `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}`);
}

/** Upserts a driver's car number for one season — replaces whatever was set for that season before. The table's primary key is (driver_id, season_id); its (season_id, car_number) unique constraint is the hard backstop against two drivers sharing a number in the same season (see 0044_driver_season_car_numbers.sql) — callers should validate that themselves first for a friendly error message, since this will otherwise throw a raw constraint-violation error. */
export async function upsertDriverSeasonCarNumber(env: SupabaseEnv, accessToken: string, data: DriverSeasonCarNumber) {
  const res = await fetch(`${env.url}/rest/v1/driver_season_car_numbers?on_conflict=driver_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on driver_season_car_numbers: ${await res.text()}`);
  const rows = (await res.json()) as DriverSeasonCarNumber[];
  return rows[0];
}

/** Clears a driver's car number override for one season — they fall back to their current number (drivers.car_number) for that season again. */
export function deleteDriverSeasonCarNumber(env: SupabaseEnv, accessToken: string, driverId: string, seasonId: string) {
  return restDelete(
    env,
    accessToken,
    `driver_season_car_numbers?driver_id=eq.${encodeURIComponent(driverId)}&season_id=eq.${encodeURIComponent(seasonId)}`
  );
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

export interface HallOfFameDriverInfo {
  id: string;
  bio: string | null;
}

/**
 * Ids (+ bio, the one extra field the public Hall of Fame page needs that
 * career-stats' own `DriverBasic` doesn't already carry) of every driver an
 * admin has marked as a Hall of Fame member (0027_hall_of_fame.sql). The
 * page itself gets everything else — name, photo, career totals,
 * season-by-season breakdown — from `computeDriverCareerStats` in
 * src/lib/results.ts and just filters that down to these ids, so a
 * driver's HOF card always reflects the exact same numbers their Driver
 * Stats row would.
 */
export function getHallOfFameDrivers(env: SupabaseEnv) {
  return restGet<HallOfFameDriverInfo[]>(env, 'drivers?select=id,bio&is_hall_of_fame=eq.true');
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
    `hall_of_fame_photos?select=${HALL_OF_FAME_PHOTO_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}&order=sort_order.asc`
  );
}

/** Every uploaded Hall of Fame photo, across every member — one query for the whole /hall-of-fame page instead of one per member. */
export function getAllHallOfFamePhotos(env: SupabaseEnv) {
  return restGet<HallOfFamePhoto[]>(env, `hall_of_fame_photos?select=${HALL_OF_FAME_PHOTO_SELECT}&order=driver_id.asc,sort_order.asc`);
}

/** Upserts the photo for one (driver, sort_order) slot — replaces whatever was in that slot before. */
export async function upsertHallOfFamePhoto(
  env: SupabaseEnv,
  accessToken: string,
  data: { driver_id: string; image_url: string; sort_order: number }
) {
  const res = await fetch(`${env.url}/rest/v1/hall_of_fame_photos?on_conflict=driver_id,sort_order`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, {
      Prefer: 'return=representation,resolution=merge-duplicates',
    }),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on hall_of_fame_photos: ${await res.text()}`);
  const rows = (await res.json()) as HallOfFamePhoto[];
  return rows[0];
}

export function deleteHallOfFamePhoto(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `hall_of_fame_photos?id=eq.${encodeURIComponent(id)}`);
}

// --- Round overrides (flag an individual round as a non-points exhibition) -

export interface RoundOverride {
  subsession_id: number;
  is_exhibition: boolean;
  /** 0036_round_test_flag.sql — independent of is_exhibition, see that migration's own comment for why these are two separate booleans rather than one category column. */
  is_test: boolean;
  note: string | null;
}

const ROUND_OVERRIDE_SELECT = 'subsession_id,is_exhibition,is_test,note';

/** subsession_ids flagged as a non-points exhibition — used to exclude those rounds from standings/champions even inside an otherwise-real championship season. */
export async function getExhibitionRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  const rows = await restGet<{ subsession_id: number }[]>(
    env,
    'round_overrides?select=subsession_id&is_exhibition=eq.true'
  );
  return new Set(rows.map((r) => r.subsession_id));
}

/** subsession_ids flagged as a test round (0036_round_test_flag.sql) — used by the results list page's Test filter, same shape as getExhibitionRoundIds. */
export async function getTestRoundIds(env: SupabaseEnv): Promise<Set<number>> {
  const rows = await restGet<{ subsession_id: number }[]>(env, 'round_overrides?select=subsession_id&is_test=eq.true');
  return new Set(rows.map((r) => r.subsession_id));
}

export async function getRoundOverride(env: SupabaseEnv, subsessionId: number) {
  const rows = await restGet<RoundOverride[]>(
    env,
    `round_overrides?select=${ROUND_OVERRIDE_SELECT}&subsession_id=eq.${subsessionId}`
  );
  return rows[0] ?? null;
}

/** Marks (or unmarks) one round as a non-points exhibition — upserts on subsession_id. Only ever writes is_exhibition; a prior is_test flag on the same row (if any) survives untouched — see 0036_round_test_flag.sql for why these are independent. */
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

/** Marks (or unmarks) one round as a test round — same upsert shape as setRoundExhibition, independent flag. */
export async function setRoundTest(env: SupabaseEnv, accessToken: string, subsessionId: number, isTest: boolean) {
  const res = await fetch(`${env.url}/rest/v1/round_overrides?on_conflict=subsession_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify({ subsession_id: subsessionId, is_test: isTest }),
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

/**
 * Every race_links row across every round that has a broadcast_url set —
 * powers the Media page's Videos → Broadcasts filter (default filter),
 * which needs "every broadcast link on file" rather than one round at a
 * time like getRaceLinksForSubsession above. src/lib/results.ts's
 * getAllBroadcastVideos() joins this with getAllRounds() for track/date
 * display context; kept here (rather than there) since it's a plain
 * race_links read with no results-pipeline computation involved.
 */
export function getAllBroadcastRaceLinks(env: SupabaseEnv): Promise<RaceLinks[]> {
  return restGetAll<RaceLinks>(env, `race_links?select=${RACE_LINKS_SELECT}&broadcast_url=not.is.null`);
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

// --- Site settings (see 0026_site_settings.sql) ---------------------------
//
// A generic key/value table for one-off, site-wide values that don't have
// a natural table of their own — unlike page_banners above, these aren't
// per-page. First (and so far only) use: 'featured_broadcast_url' (see
// src/lib/siteSettings.ts for the key constant and the YouTube-URL-to-
// embed-URL parsing), managed from /admin/site-properties.

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
 * Uploads a file to a public Storage bucket and returns its public URL.
 * `x-upsert: true` lets re-uploading to the same path (e.g. replacing a
 * team's logo) overwrite in place instead of erroring. 'imports' (see
 * 0051_activity_log.sql) holds the raw spreadsheet behind each bulk import,
 * so its activity_log row can offer a direct download link back to it.
 */
export async function uploadToStorage(
  env: SupabaseEnv,
  accessToken: string,
  bucket: 'logos' | 'photos' | 'banners' | 'imports',
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

/**
 * Wraps a Supabase Storage image URL in a Cloudflare Transformations
 * request (`/cdn-cgi/image/...`) so it's resized/re-encoded on Cloudflare's
 * edge (`format=auto` picks WebP/AVIF per the visitor's Accept header)
 * instead of shipping every logo/photo at whatever resolution it was
 * originally uploaded at — see PERFORMANCE_AUDIT.md #4. Requires
 * Images > Transformations enabled on the zone AND this project's Supabase
 * Storage host allow-listed under Transformations > Sources (both
 * dashboard-only, done once — not something this code can turn on itself).
 *
 * Root-relative on purpose (no origin baked in): `/cdn-cgi/image/...`
 * resolves against whatever origin the page itself is served from, so this
 * works unmodified on the production domain and any preview deployment
 * alike. Local `astro dev` doesn't have Transformations in front of it, so
 * these URLs would 404 there — acceptable, since local dev never needs the
 * optimization and every other Supabase-hosted `<img>` already just points
 * straight at the origin file today.
 *
 * Only rewrites actual Supabase Storage URLs — anything else (flagcdn.com,
 * a relative path, null/undefined) passes through unchanged, since only
 * this project's Storage bucket is allow-listed as a Transformations
 * source. Also passes through unchanged if no width/height was requested —
 * there'd be nothing to actually resize.
 */
export function resizedImageUrl(url: string | null | undefined, options: { width?: number; height?: number }): string | null {
  if (!url) return null;
  if (!url.includes('.supabase.co/storage/v1/object/public/')) return url;
  if (!options.width && !options.height) return url;

  const params = ['format=auto', 'fit=scale-down'];
  if (options.width) params.push(`width=${options.width}`);
  if (options.height) params.push(`height=${options.height}`);
  return `/cdn-cgi/image/${params.join(',')}/${url}`;
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
  /**
   * Which scoring_ruleset applies to this season — null means "use whichever
   * ruleset is marked default" (see ScoringRuleset.is_default / resolveSeasonRuleset
   * below), not "no ruleset at all." Column lives on `seasons` in the live
   * database already (0031_scoring_rulesets_default.sql only added
   * scoring_rulesets.is_default/updated_at, not this column); admin-editable
   * from /admin/seasons.
   */
  scoring_ruleset_id: string | null;
  /** Whether the Gamma class competed this season — see 0037_class_and_scoring_fixes.sql. Gamma didn't exist before ATC16, so this is false for older seasons unless an admin turns it on. Controls whether Gamma standings/champions/tabs show for this season on the public site. */
  gamma_enabled: boolean;
  /** Same idea as gamma_enabled, for Delta — didn't exist before ATC5. */
  delta_enabled: boolean;
  /**
   * Whether the separate Delta TEAM championship ran this season — see
   * 0052_delta_team_enabled.sql. NOT the same thing as delta_enabled: the
   * Delta driver class existed from ATC5, but the standalone Delta Team
   * competition/standings (shown alongside "Alpha Team" on /champions and
   * /team-standings) didn't start until ATC10. Controls whether Delta Team
   * standings/champions/positions show for this season on the public site.
   */
  delta_team_enabled: boolean;
}

const SEASON_SELECT =
  'id,number,name,logo_url,start_date,end_date,is_current,extra_drop_weeks,scoring_ruleset_id,gamma_enabled,delta_enabled,delta_team_enabled';

/** All seasons, newest first. */
export function getSeasons(env: SupabaseEnv) {
  return restGet<Season[]>(env, `seasons?select=${SEASON_SELECT}&order=number.desc`);
}

export async function getSeasonById(env: SupabaseEnv, id: string) {
  const seasons = await restGet<Season[]>(env, `seasons?select=${SEASON_SELECT}&id=eq.${encodeURIComponent(id)}`);
  return seasons[0] ?? null;
}

/** Sets (or clears, with `null`) a season's logo — the only field seasons can be admin-edited from (0024_season_logos_and_page_banners.sql). */
export async function updateSeasonLogo(env: SupabaseEnv, accessToken: string, id: string, logoUrl: string | null) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, { logo_url: logoUrl });
}

/** Assigns (or clears, with `null`) which scoring ruleset a season uses — see Season.scoring_ruleset_id. */
export async function updateSeasonRuleset(env: SupabaseEnv, accessToken: string, id: string, rulesetId: string | null) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, { scoring_ruleset_id: rulesetId });
}

/** Toggles a season's Gamma/Delta class-activation flags, plus the separate Delta Team championship flag — see Season.gamma_enabled/delta_enabled/delta_team_enabled. */
export async function updateSeasonClassFlags(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  flags: { gamma_enabled: boolean; delta_enabled: boolean; delta_team_enabled: boolean }
) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, flags);
}

/** One curated_rounds row's outcome from a recalculateSeasonScores() call — see recalculate_season_scores() (0034_recalculate_season_scores.sql) for why this is per-round instead of one pass/fail for the whole season. */
export interface SeasonRecalcResult {
  subsession_id: number;
  rows_written: number | null;
  error_message: string | null;
}

/**
 * Admin > Seasons' "Recalculate" button — re-runs recalculate_race_scores()
 * for every round in a season via the DB-side recalculate_season_scores()
 * wrapper, rather than looping N individual RPC calls from here (one round
 * trip instead of N, and the whole run stays inside one Postgres statement
 * so a slow round can't leave the UI hanging on a partially-done season).
 * A round-level failure doesn't abort the batch — it comes back as its own
 * row with `error_message` set, right alongside the rounds that succeeded,
 * so the caller can report exactly which rounds still need attention
 * (a missing ruleset, a round with no format set, etc.) instead of an
 * all-or-nothing outcome.
 */
export async function recalculateSeasonScores(
  env: SupabaseEnv,
  accessToken: string,
  seasonId: string
): Promise<SeasonRecalcResult[]> {
  const res = await fetch(`${env.url}/rest/v1/rpc/recalculate_season_scores`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify({ p_season_id: seasonId }),
  });
  if (!res.ok) throw new Error(`Supabase RPC error ${res.status} on recalculate_season_scores: ${await res.text()}`);
  return res.json() as Promise<SeasonRecalcResult[]>;
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

// --- Scoring rulesets (see 0031_scoring_rulesets_default.sql) --------------
//
// A ruleset's `rules` jsonb is what the DB-side recalculate_race_scores()
// function reads to actually compute race_scores from raw curated_race_results
// (base points per finish position, class-podium bonuses, Sublime Finesse,
// Class Pole, PP-penalty point deductions, drop-week count, team roster
// size/eligibility — see that function for the exact shape). This app treats
// it as an opaque JSON blob (edited as raw text in the admin UI) rather than
// modeling every field, since nothing in this repo's own TypeScript
// re-derives points from it today — see resolveSeasonRuleset's own doc
// comment for what "applying" a ruleset currently means app-side.

export interface ScoringRuleset {
  id: string;
  name: string;
  rulebook: string | null;
  /**
   * Parsed JSON (an object), NOT a string — PostgREST returns jsonb columns
   * as native JSON on every read (GET, and the `return=representation` body
   * of a create/update), same as any other jsonb column in this file.
   * Treating this field as a string (it used to be typed that way) fed an
   * already-parsed object into `JSON.parse`, which fails and falls through
   * to displaying the object's default `[object Object]` stringification —
   * see prettyJson() in src/pages/admin/rulesets/index.astro for that fix.
   *
   * createScoringRuleset/updateScoringRuleset's own `rules` param below is
   * ALSO typed `unknown` (a parsed object), not a JSON string — a previous
   * version of this comment claimed the write side should send a
   * JSON-stringified string here because "Postgres's ::jsonb cast re-parses
   * that string back into the real object on the way in." That's wrong, and
   * it corrupted this exact column in production: PostgREST doesn't run the
   * request body through Postgres's jsonb TEXT INPUT parser at all — it
   * extracts each field's value from the parsed JSON request body and hands
   * it to the target column already typed as JSON. A JSON *string* value
   * (e.g. `"rules": "{\"drops\":2,...}"`) lands in a jsonb column as a
   * jsonb STRING SCALAR whose content happens to look like JSON — it is
   * NOT re-parsed into an object. That's silent: no error, just a
   * `scoring_rulesets.rules` row that reads back as `jsonb_typeof = 'string'`
   * instead of `'object'`, and every `v_rules->'base_points'->...` lookup
   * in recalculate_race_scores() then evaluates to SQL NULL, which fails
   * loudly only once — at the NOT NULL constraint on race_scores.finish_points
   * when that round is next recalculated, by which point the mistake is
   * long past. Sending the PARSED OBJECT (not a string) as the `rules`
   * field is what makes PostgREST forward it as an actual JSON object value.
   */
  rules: unknown;
  notes: string | null;
  /** At most one ruleset can have this true at a time (partial unique index) — the ruleset a season falls back to when its own scoring_ruleset_id is null. See resolveSeasonRuleset. */
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const SCORING_RULESET_SELECT = 'id,name,rulebook,rules,notes,is_default,created_at,updated_at';

/** All scoring rulesets, alphabetical. */
export function getScoringRulesets(env: SupabaseEnv) {
  return restGet<ScoringRuleset[]>(env, `scoring_rulesets?select=${SCORING_RULESET_SELECT}&order=name.asc`);
}

export async function getScoringRulesetById(env: SupabaseEnv, id: string) {
  const rulesets = await restGet<ScoringRuleset[]>(
    env,
    `scoring_rulesets?select=${SCORING_RULESET_SELECT}&id=eq.${encodeURIComponent(id)}`
  );
  return rulesets[0] ?? null;
}

export function createScoringRuleset(
  env: SupabaseEnv,
  accessToken: string,
  data: { name: string; rulebook: string | null; rules: unknown; notes: string | null }
) {
  return restPost<ScoringRuleset>(env, accessToken, 'scoring_rulesets', data);
}

export function updateScoringRuleset(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<{ name: string; rulebook: string | null; rules: unknown; notes: string | null }>
) {
  return restPatch<ScoringRuleset>(env, accessToken, `scoring_rulesets?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteScoringRuleset(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `scoring_rulesets?id=eq.${encodeURIComponent(id)}`);
}

/**
 * Marks one ruleset as THE default (the one seasons with no ruleset of their
 * own resolve to — see resolveSeasonRuleset). Same clear-then-set two-request
 * pattern as setCurrentSeason, for the same reason: the partial unique index
 * on is_default would reject setting a second row true while the old
 * default is still true.
 */
export async function setDefaultScoringRuleset(env: SupabaseEnv, accessToken: string, rulesetId: string) {
  await restPatch<ScoringRuleset>(env, accessToken, `scoring_rulesets?is_default=eq.true&id=neq.${encodeURIComponent(rulesetId)}`, {
    is_default: false,
  });
  await restPatch<ScoringRuleset>(env, accessToken, `scoring_rulesets?id=eq.${encodeURIComponent(rulesetId)}`, {
    is_default: true,
  });
}

/**
 * Resolves which ruleset actually applies to a season: the one it's
 * explicitly assigned, or whichever is marked default if it isn't assigned
 * one. Returns null only if neither exists (no ruleset assigned AND no
 * default configured yet).
 *
 * IMPORTANT SCOPE NOTE: this app's own standings/career-stats/news-recap
 * computations (src/lib/results.ts) read already-computed `race_scores`
 * rows — they don't re-derive points from a ruleset's `rules` jsonb
 * themselves (that derivation lives entirely in the DB-side
 * recalculate_race_scores() function). So "resolving" a season's ruleset
 * today is a season-metadata/admin-display concern (showing which ruleset
 * is in effect, and which season rows still need one before scores can be
 * (re)computed for them) — it does not change what any standings page
 * shows. Wiring the resolved ruleset id back into an actual recompute is a
 * separate, larger change (see this repo's chat history for the
 * recalculate_race_scores() schema-drift issue found alongside this).
 */
export function resolveSeasonRuleset(season: Pick<Season, 'scoring_ruleset_id'>, rulesets: ScoringRuleset[]): ScoringRuleset | null {
  if (season.scoring_ruleset_id) {
    const assigned = rulesets.find((r) => r.id === season.scoring_ruleset_id);
    if (assigned) return assigned;
  }
  return rulesets.find((r) => r.is_default) ?? null;
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
  /** YouTube link to an admin-recorded track guide for this layout (0049_media_page.sql) — shown on the public Circuits page and as the "Track Guide" filter on the Media page's Videos tab. */
  track_guide_url: string | null;
}

const CIRCUIT_LAYOUT_SELECT =
  'id,circuit_id,name,length_km,lap_record_seconds,lap_record_holder,lap_record_date,image_url,corners,track_guide_url';

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
 * Same fallback order as layoutImageUrl (a layout's own image first, the
 * parent circuit's shared logo second), but for an *event* rather than a
 * CircuitLayout row directly — events.layout is a plain text name (no FK to
 * circuit_layouts, see that column's own comment on EventRecord below), so
 * this looks the matching layout up out of a full layouts list by
 * (circuit_id, name) instead of already holding a layout row. Used
 * everywhere an event/calendar card shows a circuit image, so a layout's
 * own track image (once one's on file) takes priority over the circuit's
 * generic logo — same priority the public Circuits page already uses.
 */
export function eventImageUrl(
  event: { circuit_id: string; layout: string | null },
  circuit: Pick<Circuit, 'logo_url'> | null,
  layouts: Pick<CircuitLayout, 'circuit_id' | 'name' | 'image_url'>[]
): string | null {
  const matchedLayout = event.layout ? layouts.find((l) => l.circuit_id === event.circuit_id && l.name === event.layout) : undefined;
  return matchedLayout?.image_url ?? circuit?.logo_url ?? null;
}

/**
 * Pulls the 11-character video ID out of any of the URL shapes YouTube
 * hands out (watch?v=, youtu.be/, /embed/, /shorts/) — every video entry on
 * the Media page (admin-entered or derived from race_links.broadcast_url)
 * is expected to be a YouTube link, per Logan. Returns null for anything
 * that doesn't match, so callers can fall back to a plain "watch" link
 * instead of a broken thumbnail/embed.
 */
export function youtubeVideoId(url: string): string | null {
  const match = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(url);
  return match ? match[1] : null;
}

/** YouTube's predictable thumbnail URL for a video, or null if the ID couldn't be parsed out of the given URL — see youtubeVideoId. */
export function youtubeThumbnailUrl(url: string): string | null {
  const id = youtubeVideoId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
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

/** 0050_weather_conditions_expanded.sql — expanded from the original dry/mixed/wet to this more granular set. */
export type Weather = 'clear' | 'partly_cloudy' | 'overcast' | 'raining' | 'mixed';
export type EventFormat = 'endurance' | 'sprint' | 'special';
/** 0035_events_rounds_categories.sql. 'championship' (default) expects season_id/round_number; 'test'/'exhibition' are season-agnostic, mirroring the round-level exhibition concept (round_overrides.is_exhibition) at the event level. */
export type EventCategory = 'championship' | 'test' | 'exhibition';

export interface EventRecord {
  id: string;
  circuit_id: string;
  layout: string | null;
  event_date: string; // 'YYYY-MM-DD'
  format: EventFormat;
  fuel_limit_pct: number | null;
  results_url: string | null;
  category: EventCategory;
  /** Paired with round_number (both null or both set — enforced by events_season_round_paired). Which round this event represents — matched live against curated_rounds by season_id+round_number, not a stored link. See getEventRound() in results.ts. */
  season_id: string | null;
  round_number: number | null;
  /** Manual override/pin to a specific curated_rounds row — see this column's own comment in 0035_events_rounds_categories.sql for when to use this instead of season_id+round_number auto-matching. */
  subsession_id: number | null;

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
  /** Embedded from season_id (PostgREST FK join) — null for a season-agnostic TEST/EXHIBITION event, or a championship event that hasn't been assigned a season yet. Just for display ("Round N — ATC17"); the actual round resolution is getEventRound() in results.ts, keyed off season_id/round_number/subsession_id, not this embed. */
  seasons: { name: string; number: number } | null;
}

const EVENT_SELECT =
  'id,circuit_id,layout,event_date,format,fuel_limit_pct,results_url,category,season_id,round_number,subsession_id,' +
  'practice_start_time,practice_sim_time,practice_minutes,practice_weather,' +
  'qualifying_start_time,qualifying_sim_time,qualifying_minutes,qualifying_laps,qualifying_weather,' +
  'race1_start_time,race1_sim_time,race1_laps,race1_weather,' +
  'race2_start_time,race2_sim_time,race2_laps,race2_weather,' +
  'race3_start_time,race3_sim_time,race3_laps,race3_weather';

/** All events (with circuit name/logo and season name/number embedded), soonest first. Powers the public calendar page. */
export function getEvents(env: SupabaseEnv) {
  const select = `${EVENT_SELECT},circuits(name,logo_url),seasons(name,number)`;
  return restGet<EventWithCircuit[]>(env, `events?select=${encodeURIComponent(select)}&order=event_date.asc`);
}

/** The next `limit` events from today onward — powers the homepage "Upcoming Events" widget. */
export function getUpcomingEvents(env: SupabaseEnv, limit: number) {
  const select = `${EVENT_SELECT},circuits(name,logo_url),seasons(name,number)`;
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

// ---------------------------------------------------------------------------
// MEDIA PAGE — videos (cinematics/educational/other), graphics, meetups
// (0049_media_page.sql). Broadcasts and Track Guide, the Videos tab's other
// two filters, aren't stored here — see getAllBroadcastRaceLinks above and
// CircuitLayout.track_guide_url.
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
    `media_videos?select=${MEDIA_VIDEO_SELECT}&category=eq.${encodeURIComponent(category)}&order=created_at.desc`
  );
}

export function createMediaVideo(env: SupabaseEnv, accessToken: string, data: { category: MediaVideoCategory; title: string; youtube_url: string }) {
  return restPost<MediaVideo>(env, accessToken, 'media_videos', data);
}

export function updateMediaVideo(env: SupabaseEnv, accessToken: string, id: string, data: Partial<Pick<MediaVideo, 'category' | 'title' | 'youtube_url'>>) {
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

export function createMediaGraphic(env: SupabaseEnv, accessToken: string, data: { title: string; image_url: string }) {
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
  data: { title: string; photo_url?: string | null; latitude: number; longitude: number; location_label?: string | null; meetup_date?: string | null }
) {
  return restPost<MediaMeetup>(env, accessToken, 'media_meetups', data);
}

export function updateMediaMeetup(env: SupabaseEnv, accessToken: string, id: string, data: Partial<Omit<MediaMeetup, 'id' | 'created_at'>>) {
  return restPatch<MediaMeetup>(env, accessToken, `media_meetups?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteMediaMeetup(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `media_meetups?id=eq.${encodeURIComponent(id)}`);
}
