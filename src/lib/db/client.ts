/**
 * Minimal PostgREST client over `fetch`, with no supabase-js dependency.
 * Pages run per request on the Worker, where `wrangler.jsonc` vars exist only on `Astro.locals.runtime.env`;
 * `import.meta.env.PUBLIC_*` is fixed at build time. `resolveSupabaseEnv` prefers the runtime binding and
 * falls back to `import.meta.env` for `astro dev` and prerendered pages.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  /**
   * "View as Broadcaster" (`atc_broadcaster` cookie): the latest round's subsession ids, hidden from every
   * subsession-keyed table so the site reads as if it hadn't run. Set by src/middleware.ts.
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

// Exported because the results modules (src/lib/results/) read the results and standings tables directly.
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
 * restGet that pages with the `Range` header until every row is back. Supabase caps a response at 1000 rows
 * by default, and a truncated result is silently wrong rather than an error. Same as restGet for small
 * results, so use it for any query without a natural small bound.
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
  /** Admin-entered (0011_driver_signup_date.sql); the features it is meant to power aren't built yet. */
  sign_up_date: string | null; // 'YYYY-MM-DD'
  /** Rulebook rules 57-62; isOnProbationNow() in src/lib/penalties/penaltyPoints.ts combines the two. */
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
 * All drivers by class rank then car number, with team, status and class names embedded.
 * `teams!drivers_team_id_fkey` is required: team_rosters (0008) gives a second drivers→teams path, and
 * PostgREST fails with PGRST201 rather than guess.
 */
/**
 * `aiOnly` picks everyday drivers or only AI-flagged rows (the admin Drivers "AI" tab; 0057). Never both: AI
 * rows exist only for exhibition results.
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
 * A driver's public profile: getDrivers()' shape plus bio, photo_url and is_hall_of_fame. AI-flagged drivers
 * are excluded.
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

// --- Admin / write operations ---
// These need a signed-in admin's access token: RLS (0002_auth_admin.sql) only allows writes for an admin's
// JWT, so the anon key just gets a 401.

export function writeHeaders(env: SupabaseEnv, accessToken: string, extra?: Record<string, string>) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Exported so src/lib/raceResultsImport.ts can write curated_rounds and the curated_* results tables, an
// approved one-off exception (see that file's header).
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
