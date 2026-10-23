/**
 * Pages that can have an admin-managed banner (0024), driving /admin/site-properties and each page's lookup.
 * Top-level pages only, plus one shared banner for all round results and one for all incident reports. 'home'
 * renders as the full homepage hero inline in index.astro, not through PageBanner.
 */
export interface BannerPageDef {
  key: string;
  label: string;
  description: string;
  /**
   * Rendered width in px (the section's max-w), so the admin crop frame matches what shows: 1024 = max-w-5xl,
   * 1152 = max-w-6xl. Omit for 'home'.
   */
  width?: number;
}

/** Desktop banner strip height in px (PageBanner's sm:h-56). */
export const BANNER_STRIP_HEIGHT = 224;
/** Phone banner strip: full width of a ~390px phone by h-40 (160px). */
export const BANNER_PHONE_ASPECT = 390 / 160;

export const BANNER_PAGES: BannerPageDef[] = [
  {
    key: 'home',
    label: 'Home',
    description: 'The hero section behind the "Alpha Touring Challenge" headline.',
  },
  { key: 'standings', label: 'Standings', description: '/standings', width: 1152 },
  { key: 'team-standings', label: 'Team Standings', description: '/team-standings', width: 1152 },
  { key: 'roster', label: 'Driver Roster', description: '/roster', width: 1152 },
  { key: 'calendar', label: 'Calendar', description: '/calendar', width: 1024 },
  { key: 'champions', label: 'Champions', description: '/champions', width: 1024 },
  { key: 'teams', label: 'Teams', description: '/teams', width: 1152 },
  { key: 'news', label: 'News', description: '/news', width: 1152 },
  { key: 'circuits', label: 'Circuits', description: '/circuits', width: 1024 },
  { key: 'results', label: 'Race Results', description: '/results', width: 1024 },
  {
    key: 'round-results',
    label: 'Round Results',
    description: "One round's results page (/results/…) — shown on every round",
    width: 1024,
  },
  {
    key: 'incident-report',
    label: 'Incident Report',
    description: "One round's incident report page (/results/…/incidents) — shown on every round",
    width: 1152,
  },
  { key: 'driver-stats', label: 'Driver Stats', description: '/driver-stats', width: 1152 },
  { key: 'team-stats', label: 'Team Stats', description: '/team-stats', width: 1152 },
  { key: 'hall-of-fame', label: 'Hall of Fame', description: '/hall-of-fame', width: 1024 },
  { key: 'awards', label: 'Awards', description: '/awards', width: 1024 },
  { key: 'media', label: 'Media', description: '/media', width: 1024 },
  { key: 'incidents', label: 'Incidents', description: '/incidents', width: 1152 },
];

import { resizedImageSrcset, resizedImageUrl } from './db/drivers';

/** One page's stored banner URL, unresized, or null. bannerImage turns it into what the page renders. */
export function bannerUrlFor(
  banners: { page_key: string; image_url: string }[],
  pageKey: string,
): string | null {
  return banners.find((b) => b.page_key === pageKey)?.image_url ?? null;
}

/**
 * Banner widths for the srcset. 1600 stays the largest, as when a single size was served, so no screen gets a
 * sharper or softer banner than before; narrower windows can take a smaller one.
 */
const BANNER_WIDTHS = [960, 1280, 1600];

/**
 * A banner's <img> src and srcset. Banners are often a page's heaviest image, so all of them go through
 * resizedImageUrl here; srcset is null for a URL that can't be resized (one pasted from another host).
 */
export function bannerImage(url: string): { src: string; srcset: string | null } {
  return {
    src: resizedImageUrl(url, { width: 1600 }) ?? url,
    srcset: resizedImageSrcset(url, BANNER_WIDTHS),
  };
}
