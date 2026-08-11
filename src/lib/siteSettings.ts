/**
 * Key constants + helpers for the generic `site_settings` key/value table
 * (see 0026_site_settings.sql / src/lib/supabase.ts's getSiteSettings /
 * upsertSiteSetting). Mirrors src/lib/pageBanners.ts's role for
 * page_banners — the single place that knows what keys exist and what
 * they mean.
 */

/** The homepage "Featured Broadcast" YouTube URL — set from /admin/site-settings, rendered by src/pages/index.astro. */
export const FEATURED_BROADCAST_URL_KEY = 'featured_broadcast_url';

/**
 * Driver settings (0041_driver_settings.sql) — set from the "Driver
 * Settings" panel above the admin Drivers list. Both pairs follow the same
 * "whichever is longer" shape: a driver only crosses over once BOTH the
 * days threshold AND the rounds threshold have been met, the same rule
 * 61 already used for probation and 0040 introduced for inactivity — this
 * just makes the numbers themselves editable instead of hardcoded.
 * sync_driver_statuses() reads INACTIVITY_* directly out of site_settings
 * itself (it's a DB function); isOnProbationNow() in src/lib/penalties.ts
 * takes PROBATION_* as plain params so callers (currently just
 * src/pages/roster.astro) load them once and pass them through.
 */
export const PROBATION_DAYS_KEY = 'probation_days';
export const PROBATION_ROUNDS_KEY = 'probation_rounds';
export const INACTIVITY_DAYS_KEY = 'inactivity_days';
export const INACTIVITY_ROUNDS_KEY = 'inactivity_rounds';

/** Defaults matching what was hardcoded before these became configurable — used whenever a key is unset (nothing has ever saved it) or holds something non-numeric. */
export const DRIVER_SETTING_DEFAULTS: Record<string, number> = {
  [PROBATION_DAYS_KEY]: 45,
  [PROBATION_ROUNDS_KEY]: 4,
  [INACTIVITY_DAYS_KEY]: 90,
  [INACTIVITY_ROUNDS_KEY]: 12,
};

/** Looks up one setting's value, or null if unset. */
export function siteSettingValue(settings: { setting_key: string; value: string | null }[], key: string): string | null {
  return settings.find((s) => s.setting_key === key)?.value ?? null;
}

/** Same as siteSettingValue, but parsed as a positive integer — falls back to DRIVER_SETTING_DEFAULTS[key] (or 0 if that's also unset) when the stored value is missing, blank, zero, or not a valid number. Zero is treated as invalid rather than "instantly trigger" so it can't be set by accident — same reasoning sync_driver_statuses() (0041_driver_settings.sql) applies on the DB side, kept consistent here. */
export function siteSettingInt(settings: { setting_key: string; value: string | null }[], key: string): number {
  const raw = siteSettingValue(settings, key);
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DRIVER_SETTING_DEFAULTS[key] ?? 0;
  return Math.round(n);
}

/**
 * Turns a normal YouTube URL (watch?v=, youtu.be/, /live/, /shorts/, or an
 * already-correct /embed/ URL) into the `/embed/VIDEO_ID` form an <iframe>
 * needs. Returns null for anything that isn't recognizably a YouTube URL,
 * so the caller can just skip rendering the embed rather than pointing an
 * iframe at something broken.
 */
export function youtubeEmbedUrl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '');
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = parsed.pathname.slice(1).split('/')[0] || null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (parsed.pathname.startsWith('/embed/')) {
      videoId = parsed.pathname.slice('/embed/'.length).split('/')[0] || null;
    } else if (parsed.pathname.startsWith('/live/')) {
      videoId = parsed.pathname.slice('/live/'.length).split('/')[0] || null;
    } else if (parsed.pathname.startsWith('/shorts/')) {
      videoId = parsed.pathname.slice('/shorts/'.length).split('/')[0] || null;
    }
  }

  if (!videoId) return null;
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
}
