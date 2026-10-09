/**
 * The full list of pages that can have an admin-managed banner image (see
 * 0024_season_logos_and_page_banners.sql / page_banners table). Drives both
 * /admin/site-properties (one row per entry here) and each public page's own
 * fetch (`banners.find((b) => b.page_key === 'standings')`, etc).
 *
 * Deliberately scoped to top-level/static pages only — dynamic detail pages
 * (an individual news post, a specific circuit) don't have a single stable
 * "page" to hang one banner off of, so they're left out rather than trying
 * to force a per-record banner into this same simple key-value shape. The one
 * exception is 'round-results': one banner shared by every round's results
 * page (not a per-round banner).
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
  /**
   * Width in px of the page's content column (its <section>'s max-w), which
   * is how wide the banner actually renders on desktop — PageBanner is
   * absolutely positioned inside that section, not the full window. The
   * admin crop frame is sized from this so what you crop is what shows.
   * 1024 = max-w-5xl, 1152 = max-w-6xl. Omit for 'home' (full-width hero).
   */
  width?: number;
}

/** Desktop banner strip height in px (PageBanner's sm:h-56). */
export const BANNER_STRIP_HEIGHT = 224;
/** Phone banner strip: full width of a ~390px phone by h-40 (160px). */
export const BANNER_PHONE_ASPECT = 390 / 160;

export const BANNER_PAGES: BannerPageDef[] = [
  { key: 'home', label: 'Home', description: 'The hero section behind the "Alpha Touring Challenge" headline.' },
  { key: 'standings', label: 'Standings', description: '/standings', width: 1152 },
  { key: 'team-standings', label: 'Team Standings', description: '/team-standings', width: 1152 },
  { key: 'roster', label: 'Driver Roster', description: '/roster', width: 1152 },
  { key: 'calendar', label: 'Calendar', description: '/calendar', width: 1024 },
  { key: 'champions', label: 'Champions', description: '/champions', width: 1024 },
  { key: 'teams', label: 'Teams', description: '/teams', width: 1152 },
  { key: 'news', label: 'News', description: '/news', width: 1152 },
  { key: 'circuits', label: 'Circuits', description: '/circuits', width: 1024 },
  { key: 'results', label: 'Race Results', description: '/results', width: 1024 },
  { key: 'round-results', label: 'Round Results', description: 'One round\'s results page (/results/…) — shown on every round', width: 1024 },
  { key: 'driver-stats', label: 'Driver Stats', description: '/driver-stats', width: 1152 },
  { key: 'team-stats', label: 'Team Stats', description: '/team-stats', width: 1152 },
  { key: 'hall-of-fame', label: 'Hall of Fame', description: '/hall-of-fame', width: 1024 },
  { key: 'awards', label: 'Awards', description: '/awards', width: 1024 },
  { key: 'media', label: 'Media', description: '/media', width: 1024 },
  { key: 'incidents', label: 'Incidents', description: '/incidents', width: 1152 },
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
