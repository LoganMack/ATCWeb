/**
 * The full list of pages that can have an admin-managed banner image (see
 * 0024_season_logos_and_page_banners.sql / page_banners table). Drives both
 * /admin/site-properties (one row per entry here) and each public page's own
 * fetch (`banners.find((b) => b.page_key === 'standings')`, etc).
 *
 * Deliberately scoped to top-level/static pages only — dynamic detail pages
 * (an individual race result, an individual news post, a specific circuit)
 * don't have a single stable "page" to hang one banner off of, so they're
 * left out rather than trying to force a per-record banner into this same
 * simple key-value shape.
 *
 * 'home' is the one special case: it renders as the full hero section
 * behind the homepage headline (see src/pages/index.astro) rather than the
 * thin top-of-page strip every other entry here renders as (see
 * src/components/PageBanner.astro) — different enough visual treatment
 * that it's handled inline in index.astro instead of through PageBanner.
 */
export interface BannerPageDef {
  key: string;
  label: string;
  description: string;
}

export const BANNER_PAGES: BannerPageDef[] = [
  { key: 'home', label: 'Home', description: 'The hero section behind the "Alpha Touring Challenge" headline.' },
  { key: 'standings', label: 'Standings', description: '/standings' },
  { key: 'team-standings', label: 'Team Standings', description: '/team-standings' },
  { key: 'roster', label: 'Driver Roster', description: '/roster' },
  { key: 'calendar', label: 'Calendar', description: '/calendar' },
  { key: 'champions', label: 'Champions', description: '/champions' },
  { key: 'teams', label: 'Teams', description: '/teams' },
  { key: 'news', label: 'News', description: '/news' },
  { key: 'circuits', label: 'Circuits', description: '/circuits' },
  { key: 'results', label: 'Race Results', description: '/results' },
  { key: 'driver-stats', label: 'Driver Stats', description: '/driver-stats' },
  { key: 'team-stats', label: 'Team Stats', description: '/team-stats' },
  { key: 'hall-of-fame', label: 'Hall of Fame', description: '/hall-of-fame' },
  { key: 'media', label: 'Media', description: '/media' },
];

import { resizedImageUrl } from './supabase';

/**
 * Looks up one page's configured banner URL, or null if none is set.
 * Banners are full-page-width background images — often the single
 * heaviest image on any given page — so this is the one place that fixes
 * all of them (every PageBanner.astro strip plus the homepage hero) at
 * once via resizedImageUrl (see that function's own doc comment for the
 * Cloudflare Transformations setup this depends on).
 */
export function bannerUrlFor(banners: { page_key: string; image_url: string }[], pageKey: string): string | null {
  const url = banners.find((b) => b.page_key === pageKey)?.image_url ?? null;
  return resizedImageUrl(url, { width: 1600 });
}
