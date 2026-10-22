import { restGet, restGetAuthed, writeHeaders, type SupabaseEnv } from './client';

// --- Site analytics (0077_page_views.sql; its header has the privacy design) ---
// Only src/middleware.ts logs page views: it has the request data and decides what counts as a visit.

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
   * The window's own totals and its length in days (null = all time), from 0103. Optional for a database
   * without 0103; callers fall back to visitors30d/views30d.
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
 * get_page_view_stats() (0077) under the admin's token, which passes the admin-only RLS. Null on failure so
 * the dashboard skips the block. `days` is the window (null = all time); the default 30 sends no argument, so
 * it works before 0103 added p_days.
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
 * get_news_post_view_counts(): distinct-visitor views per `/news/<slug>` path, for the admin News list's
 * Views column. Admin-only like getPageViewStats; null on failure so the column is skipped.
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

// --- Admin dashboard summary counts (card subtitles) ---

/**
 * get_missing_race_results_count() (0078): past championship events with no race results. Only a count over
 * public tables, so it runs with the anon key.
 */
export async function getMissingRaceResultsCount(env: SupabaseEnv): Promise<number> {
  return restGet<number>(env, 'rpc/get_missing_race_results_count');
}

/**
 * activity_log rows since `sinceIso`, for the Activity Log card. The table is small, so a plain select and
 * .length is enough.
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
