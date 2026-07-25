/**
 * Row shapes for every table this app reads or writes.
 *
 * These are hand-written and must be kept in sync with supabase/migrations/
 * by hand. That's the next thing worth fixing: `supabase gen types
 * typescript --linked > src/lib/db/database.types.ts` generates them from the
 * live schema, at which point this file becomes a thin set of aliases /
 * view-specific projections over the generated types rather than a second
 * source of truth. See the README's "Database types" section.
 */

// --- Lookups ---------------------------------------------------------------

export interface Lookup {
  id: number;
  name: string;
  sort_order: number;
}

// --- Teams -----------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  primary_color_hex: string | null;
  logo_url: string | null;
}

// --- Drivers ---------------------------------------------------------------

/**
 * The public/read shape: FK columns resolved to names via PostgREST resource
 * embedding. This is what the roster and admin list pages render.
 */
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

/**
 * The edit shape: raw FK columns, because a form posts back `status_id` /
 * `class_id` / `team_id`, not names. Same table as `Driver` above — two
 * projections of it, not two tables.
 */
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

// --- News ------------------------------------------------------------------

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

/** Adds the draft/published flag, which only admins are allowed to see. */
export interface NewsPostAdmin extends NewsPost {
  status: 'draft' | 'published';
}

// --- Profiles --------------------------------------------------------------

export interface Profile {
  id: string;
  role: 'admin' | 'driver';
  display_name: string | null;
  driver_id: string | null;
  iracing_cust_id: number | null;
  iracing_name: string | null;
}

// --- Storage ---------------------------------------------------------------

export type StorageBucket = 'logos' | 'photos';
