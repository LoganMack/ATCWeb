/**
 * Minimal PostgREST client — deliberately not using @supabase/supabase-js.
 * For a read-mostly public site, a couple of typed `fetch` wrappers against
 * Supabase's auto-generated REST API cover everything we need with zero
 * extra dependencies. Reach for the full SDK later if auth, realtime
 * subscriptions, or file storage get added.
 *
 * IMPORTANT — where the URL/key come from:
 * Every page that calls into this file has `export const prerender = false`,
 * meaning it runs per-request on Cloudflare's Worker, not at build time.
 * `import.meta.env.PUBLIC_*` only gets a value baked in at *build* time —
 * on Cloudflare's build pipeline, `wrangler.jsonc`'s `vars` (and dashboard
 * variables bound to the Worker) are a *runtime* concept, only visible via
 * `Astro.locals.runtime.env` once the Worker is actually handling a
 * request. Reading `import.meta.env` here silently built with `undefined`
 * every time — the real reason nothing ever loaded in production,
 * independent of the wrangler.jsonc vars-wiping bug fixed earlier.
 * `resolveSupabaseEnv` below prefers the runtime binding and only falls
 * back to `import.meta.env` where that's genuinely the right source (local
 * `astro dev`, or a page that's actually prerendered).
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  /**
   * "View as Broadcaster" (footer toggle, `atc_broadcaster` cookie): the
   * subsession id(s) of the most recent round, which restGet/restGetAll then
   * exclude from every subsession-keyed table (see SUBSESSION_KEYED_TABLES)
   * so every stat on the site reads as if that round never existed. Empty/
   * undefined for everyone else. Populated by src/middleware.ts into
   * `locals.broadcasterHiddenSubsessionIds`, which resolveSupabaseEnv below
   * carries onto the env every page already builds from `Astro.locals`.
   */
  hiddenSubsessionIds?: number[];
  /**
   * A signed-in user's JWT for restGet/restGetAll, so reads run under that
   * user's RLS instead of the anon key's. Only set on admin paths that must
   * see unposted rounds' penalties (0112) — see withAccessToken.
   */
  accessToken?: string;
}

/**
 * Tables keyed by `subsession_id` that hold a round's own data. Excluded:
 * `events` (the calendar itself must stay intact), and `incident_reports`
 * (steward workflow, not a statistic).
 */
const SUBSESSION_KEYED_TABLES = new Set([
  'curated_rounds',
  'curated_race_results',
  'curated_qualifying',
  'curated_practice_results',
  'race_scores',
  'race_scores_public',
  'race_score_results_public',
  'penalties',
  'race_links',
  'round_overrides',
  'manual_result_imports',
]);

export function withHiddenRounds(env: SupabaseEnv, path: string): string {
  const ids = env.hiddenSubsessionIds;
  if (!ids || ids.length === 0) return path;
  const table = path.split('?')[0];
  if (!SUBSESSION_KEYED_TABLES.has(table)) return path;
  const filter = `subsession_id=not.in.(${ids.join(',')})`;
  return path.includes('?') ? `${path}&${filter}` : `${path}?${filter}`;
}

export function resolveSupabaseEnv(locals: App.Locals): SupabaseEnv {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string> } } | undefined)?.runtime?.env;
  return {
    url: runtimeEnv?.PUBLIC_SUPABASE_URL || import.meta.env.PUBLIC_SUPABASE_URL,
    anonKey: runtimeEnv?.PUBLIC_SUPABASE_ANON_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
    hiddenSubsessionIds: locals?.broadcasterHiddenSubsessionIds,
  };
}

/** The same env, but reads go out as this user (their RLS applies). Admin-only paths, never on publicly cached pages. */
export function withAccessToken(env: SupabaseEnv, accessToken: string): SupabaseEnv {
  return { ...env, accessToken };
}

function restHeaders(env: SupabaseEnv) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${env.accessToken ?? env.anonKey}`,
  };
}

// Exported (unlike the write-side helpers below) because src/lib/results.ts
// needs it directly for the results/standings tables, which aren't owned by
// this file's usual per-table CRUD pattern — see that file's header comment.
export async function restGet<T>(env: SupabaseEnv, path: string): Promise<T> {
  if (!env.url || !env.anonKey) {
    throw new Error(
      'Supabase URL/anon key are not set (checked both the Cloudflare runtime env and import.meta.env).',
    );
  }
  const res = await fetch(`${env.url}/rest/v1/${withHiddenRounds(env, path)}`, {
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
    throw new Error(
      'Supabase URL/anon key are not set (checked both the Cloudflare runtime env and import.meta.env).',
    );
  }
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${env.url}/rest/v1/${withHiddenRounds(env, path)}`, {
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
/**
 * `aiOnly` (default false) switches between the two mutually-exclusive
 * views this ever needs: everyday drivers (`is_ai=eq.false` — every public
 * page, and the admin Drivers list's default "All" tab) or exactly the
 * AI-flagged rows (`is_ai=eq.true` — the admin Drivers list's "AI" tab
 * only, see 0057_driver_ai_flag.sql). Never both at once — an AI row exists
 * solely to satisfy an exhibition result's FK and is never meant to appear
 * alongside real drivers anywhere this function is used.
 */
export function getDrivers(env: SupabaseEnv, { aiOnly = false }: { aiOnly?: boolean } = {}) {
  const select =
    'id,car_number,name,is_rookie,car,appearances,starts,seasons_count,' +
    'penalty_points,penalty_points_max,sign_up_date,on_probation,probation_started_at,nationality_1,nationality_2,' +
    'driver_statuses(name),driver_classes(name),teams!drivers_team_id_fkey(name,primary_color_hex,logo_url)';
  return restGet<Driver[]>(
    env,
    `drivers?select=${encodeURIComponent(select)}&is_ai=eq.${aiOnly}&order=car_number.asc.nullslast`,
  );
}

/**
 * One driver's full public profile — the same embedded-names shape
 * getDrivers() uses (see that function's own doc comment for why
 * `teams!drivers_team_id_fkey`, not plain `teams(...)`, is required here)
 * plus the handful of extra fields getDrivers() leaves out because the
 * roster table doesn't show them: bio, photo_url, is_hall_of_fame. Powers
 * the driver profile page (src/pages/drivers/[id].astro), reached by
 * clicking a roster row. Excludes AI-flagged drivers (0057_driver_ai_flag.sql)
 * — same default as getDrivers() — since an AI entrant has no real profile
 * to show.
 */
export interface DriverProfile {
  id: string;
  car_number: number | null;
  name: string;
  is_rookie: boolean;
  car: string | null;
  bio: string | null;
  photo_url: string | null;
  is_hall_of_fame: boolean;
  sign_up_date: string | null;
  on_probation: boolean;
  probation_started_at: string | null;
  nationality_1: string | null;
  nationality_2: string | null;
  driver_statuses: { name: string } | null;
  driver_classes: { name: string } | null;
  teams: { id: string; name: string; primary_color_hex: string | null; logo_url: string | null } | null;
}

const DRIVER_PROFILE_SELECT =
  'id,car_number,name,is_rookie,car,bio,photo_url,is_hall_of_fame,sign_up_date,on_probation,probation_started_at,' +
  'nationality_1,nationality_2,driver_statuses(name),driver_classes(name),teams!drivers_team_id_fkey(id,name,primary_color_hex,logo_url)';

export async function getDriverProfileById(env: SupabaseEnv, id: string): Promise<DriverProfile | null> {
  const drivers = await restGet<DriverProfile[]>(
    env,
    `drivers?select=${encodeURIComponent(DRIVER_PROFILE_SELECT)}&id=eq.${encodeURIComponent(id)}&is_ai=eq.false`,
  );
  return drivers[0] ?? null;
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
export async function getNewsPostBySlug(env: SupabaseEnv, slug: string): Promise<NewsPost | null> {
  const posts = await restGet<NewsPost[]>(
    env,
    `news_posts?select=${NEWS_PUBLIC_SELECT}&slug=eq.${encodeURIComponent(slug)}&limit=1`,
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

export function writeHeaders(env: SupabaseEnv, accessToken: string, extra?: Record<string, string>) {
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

export async function restPost<T>(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase insert error ${res.status} on ${path}: ${await res.text()}`);
  const rows = (await res.json()) as T[];
  return rows[0];
}

export async function restPatch<T>(
  env: SupabaseEnv,
  accessToken: string,
  path: string,
  body: unknown,
): Promise<T> {
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
