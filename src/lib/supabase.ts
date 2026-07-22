/**
 * Minimal PostgREST client — deliberately not using @supabase/supabase-js.
 * For a read-mostly public site, a couple of typed `fetch` wrappers against
 * Supabase's auto-generated REST API cover everything we need with zero
 * extra dependencies. Reach for the full SDK later if you add auth,
 * realtime subscriptions, or file storage.
 */

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

function restHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

async function restGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: restHeaders(),
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
export function getDrivers() {
  const select =
    'id,car_number,name,is_rookie,car,appearances,starts,seasons_count,' +
    'penalty_points,penalty_points_max,' +
    'driver_statuses(name),driver_classes(name),teams(name,primary_color_hex,logo_url)';
  return restGet<Driver[]>(
    `drivers?select=${encodeURIComponent(select)}&order=car_number.asc.nullslast`
  );
}

/** Published news posts, newest first. */
export function getNewsPosts(limit?: number) {
  const params = new URLSearchParams({
    select: 'id,slug,title,excerpt,body,cover_image_url,author_name,published_at',
    order: 'published_at.desc',
  });
  if (limit) params.set('limit', String(limit));
  return restGet<NewsPost[]>(`news_posts?${params.toString()}`);
}

/** A single published news post by slug. */
export async function getNewsPostBySlug(slug: string) {
  const select = 'id,slug,title,excerpt,body,cover_image_url,author_name,published_at';
  const posts = await restGet<NewsPost[]>(
    `news_posts?select=${select}&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  return posts[0] ?? null;
}
