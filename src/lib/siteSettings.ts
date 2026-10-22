/**
 * Keys and helpers for the `site_settings` table (0026; getSiteSettings/upsertSiteSetting in
 * src/lib/db/assets.ts): the one place that knows which keys exist.
 */

/**
 * Driver settings (0041), set from the admin Drivers panel. Both pairs mean "whichever is longer": a driver
 * crosses over only when the days and the rounds thresholds are both met (rule 61, 0040).
 * sync_driver_statuses() reads INACTIVITY_* itself; PROBATION_* are passed to isOnProbationNow()
 * (src/lib/penalties/penaltyPoints.ts).
 */
export const PROBATION_DAYS_KEY = 'probation_days';
export const PROBATION_ROUNDS_KEY = 'probation_rounds';
export const INACTIVITY_DAYS_KEY = 'inactivity_days';
export const INACTIVITY_ROUNDS_KEY = 'inactivity_rounds';

/**
 * How long, in hours, incident reporting stays open after a round's race is
 * over (see src/lib/incidentReports.ts) — edited under admin > Site
 * Properties. Falls back to the default when unset/invalid.
 */
export const INCIDENT_REPORT_PERIOD_HOURS_KEY = 'incident_report_period_hours';

/**
 * How long, in hours, drivers can submit an appeal for an incident after the
 * round's incident report has been POSTED (see src/lib/incidentAppeals.ts).
 * Edited under admin > Site Properties next to the reporting window.
 */
export const INCIDENT_APPEAL_PERIOD_HOURS_KEY = 'incident_appeal_period_hours';

/** Defaults matching what was hardcoded before these became configurable — used whenever a key is unset (nothing has ever saved it) or holds something non-numeric. */
export const DRIVER_SETTING_DEFAULTS: Record<string, number> = {
  [PROBATION_DAYS_KEY]: 45,
  [PROBATION_ROUNDS_KEY]: 4,
  [INACTIVITY_DAYS_KEY]: 90,
  [INACTIVITY_ROUNDS_KEY]: 12,
  [INCIDENT_REPORT_PERIOD_HOURS_KEY]: 24,
  [INCIDENT_APPEAL_PERIOD_HOURS_KEY]: 24,
};

/** Looks up one setting's value, or null if unset. */
export function siteSettingValue(
  settings: { setting_key: string; value: string | null }[],
  key: string,
): string | null {
  return settings.find((s) => s.setting_key === key)?.value ?? null;
}

/** Same as siteSettingValue, but parsed as a positive integer — falls back to DRIVER_SETTING_DEFAULTS[key] (or 0 if that's also unset) when the stored value is missing, blank, zero, or not a valid number. Zero is treated as invalid rather than "instantly trigger" so it can't be set by accident — same reasoning sync_driver_statuses() (0041_driver_settings.sql) applies on the DB side, kept consistent here. */
export function siteSettingInt(
  settings: { setting_key: string; value: string | null }[],
  key: string,
): number {
  const raw = siteSettingValue(settings, key);
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DRIVER_SETTING_DEFAULTS[key] ?? 0;
  return Math.round(n);
}

/**
 * The `/embed/VIDEO_ID` form an <iframe> needs, from any YouTube URL shape; null otherwise so the embed is
 * skipped.
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
