/**
 * Key constants + helpers for the generic `site_settings` key/value table
 * (see 0026_site_settings.sql / src/lib/supabase.ts's getSiteSettings /
 * upsertSiteSetting). Mirrors src/lib/pageBanners.ts's role for
 * page_banners — the single place that knows what keys exist and what
 * they mean.
 */

/** The homepage "Featured Broadcast" YouTube URL — set from /admin/site-settings, rendered by src/pages/index.astro. */
export const FEATURED_BROADCAST_URL_KEY = 'featured_broadcast_url';

/** Looks up one setting's value, or null if unset. */
export function siteSettingValue(settings: { setting_key: string; value: string | null }[], key: string): string | null {
  return settings.find((s) => s.setting_key === key)?.value ?? null;
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
