import { restGet, restGetAuthed, writeHeaders, type SupabaseEnv } from './client';

// --- Site analytics (0077_page_views.sql) -----------------------------------
// Backs the admin dashboard's "site analytics" block. See that migration's
// header comment for the full privacy design (no raw IP stored, daily-
// rotating visitor hash, Cloudflare's own request.cf.country — no third
// party involved anywhere). src/middleware.ts is the only caller of
// logPageView — it has the Request/cf data this needs and decides which
// requests actually count as a real page visit.

/**
 * Fire-and-forget page view through record_page_view() (0114), which applies
 * the field checks and the per-visitor rate limit; anon can no longer insert
 * into page_views directly. Uses the plain anon key (a real visitor is never
 * signed in). Never throws: analytics must not break a page.
 */
export async function logPageView(
  env: SupabaseEnv,
  entry: { path: string; country: string | null; visitorHash: string; status: number },
): Promise<void> {
  try {
    if (!env.url || !env.anonKey) return;
    const res = await fetch(`${env.url}/rest/v1/rpc/record_page_view`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${env.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_path: entry.path,
        p_visitor_hash: entry.visitorHash,
        p_country: entry.country,
        p_status: entry.status,
      }),
    });
    if (!res.ok) console.error(`Failed to log page view: record_page_view returned ${res.status}`);
  } catch (err) {
    console.error('Failed to log page view:', err);
  }
}

export interface PageViewStats {
  visitorsToday: number;
  viewsToday: number;
  visitors7d: number;
  views7d: number;
  visitors30d: number;
  views30d: number;
  /**
   * The reporting window's own totals, and its length in days (null = all
   * time) — added by 0103_page_view_stats_performance.sql along with the
   * p_days argument. Optional because a database that hasn't run 0103 yet
   * doesn't return them; callers fall back to visitors30d/views30d.
   */
  rangeDays?: number | null;
  visitorsRange?: number;
  viewsRange?: number;
  /** The reporting window (see `rangeDays`), most-visited first — see get_page_view_stats() for the exact grouping/limit. */
  topCountries: { country: string; visitors: number }[];
  /** Always exactly 24 entries (hour 0-23, America/New_York), over the reporting window — see get_page_view_stats() for why every hour is guaranteed present even with zero views. */
  hourly: { hour: number; views: number }[];
  /** Same shape as `hourly` above, scoped to just today's calendar date in America/New_York instead of the reporting window — see get_page_view_stats() (0083_page_views_hourly_today.sql). */
  hourlyToday: { hour: number; views: number }[];
  /** The reporting window, successful (200) views only, most-visited first — see get_page_view_stats() (0080_page_views_status_and_stats.sql). */
  topPages: { path: string; views: number }[];
  /** The reporting window, status >= 400 only, grouped by path+status so a 404 and a 500 on the same path show separately. */
  topErrors: { path: string; status: number; occurrences: number }[];
}

/**
 * Reads get_page_view_stats() (0077_page_views.sql) — the admin's own accessToken is what actually gets past that table's admin-only RLS read policy, same as every other admin-only RPC in this file. Returns null (rather than throwing) on any failure so the dashboard can just skip the analytics block instead of failing the whole page.
 *
 * `days` is the reporting window (null = all time). The default 30 sends no
 * argument at all, so it works against the function both before and after
 * 0103_page_view_stats_performance.sql added p_days; any other window
 * needs 0103 to have been run.
 */
export async function getPageViewStats(
  env: SupabaseEnv,
  accessToken: string,
  days: number | null = 30,
): Promise<PageViewStats | null> {
  try {
    const res = await fetch(`${env.url}/rest/v1/rpc/get_page_view_stats`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify(days === 30 ? {} : { p_days: days }),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as PageViewStats;
  } catch (err) {
    console.error('Failed to load page view stats:', err);
    return null;
  }
}

export interface NewsPostViewCount {
  path: string;
  views: number;
}

/**
 * Reads get_news_post_view_counts() (news_post_view_counts migration) — one
 * row per `/news/<slug>` path that's ever actually been hit, with its
 * all-time unique (distinct visitor_hash) view count. Backs the "Views"
 * column on the admin News list. Same admin-only RLS gate as
 * getPageViewStats (the accessToken is what actually gets past
 * page_views' "admin read" policy). Returns null (rather than throwing) on
 * any failure so the admin news list can just skip the Views column
 * instead of failing the whole page.
 */
export async function getNewsPostViewCounts(
  env: SupabaseEnv,
  accessToken: string,
): Promise<NewsPostViewCount[] | null> {
  try {
    const res = await fetch(`${env.url}/rest/v1/rpc/get_news_post_view_counts`, {
      method: 'POST',
      headers: writeHeaders(env, accessToken),
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as NewsPostViewCount[];
  } catch (err) {
    console.error('Failed to load news post view counts:', err);
    return null;
  }
}

// --- Admin dashboard summary counts ----------------------------------------
// Small, single-purpose count helpers backing the /admin dashboard card
// subtitles — kept separate from each table's own CRUD functions above
// since these exist purely to answer "how many," not to fetch real rows.

/**
 * Reads get_missing_race_results_count() (0078_curated_rounds_event_id_and_practice_results.sql)
 * — a championship event counts as "missing" once it's in the past and has
 * no curated_rounds row (linked via event_id) with a curated_race_results
 * row under it. Not admin-gated at the DB level (see that migration's own
 * comment — it exposes only a count over already-public tables), so this
 * calls it with the anon key via GET, same as any other public read.
 */
export async function getMissingRaceResultsCount(env: SupabaseEnv): Promise<number> {
  return restGet<number>(env, 'rpc/get_missing_race_results_count');
}

/**
 * Count of activity_log rows created since `sinceIso` — backs the Activity
 * Log dashboard card's "N in the last 24 hours" subtitle. Follows the same
 * fetch-then-.length convention as admin/activity-log/index.astro's own
 * query (activity_log has no dedicated count RPC — it's a small, admin-only
 * table, so a plain filtered select is plenty cheap).
 */
export async function getActivityLogCountSince(
  env: SupabaseEnv,
  accessToken: string,
  sinceIso: string,
): Promise<number> {
  const rows = await restGetAuthed<{ id: string }[]>(
    env,
    accessToken,
    `activity_log?select=id&created_at=gte.${encodeURIComponent(sinceIso)}`,
  );
  return rows.length;
}
