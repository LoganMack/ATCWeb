import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * JSON endpoint behind the Media page's Graphics tab "Round Photo Albums"
 * list (src/pages/media.astro) — given `?url=` (a race_links.photo_album_url
 * value), returns `{ thumbnailUrl: string | null }` for that album's cover
 * image.
 *
 * Why this is its own lazy endpoint rather than resolved server-side inline
 * in media.astro: unlike youtubeThumbnailUrl() (a pure URL-pattern function,
 * zero network calls — a YouTube video ID predictably maps to
 * img.youtube.com/vi/<id>/...), there is no equivalent trick for Flickr.
 * Flickr's real per-photo image URLs are
 * https://live.staticflickr.com/<server>/<id>_<secret>_<size>.jpg — the
 * server id and secret aren't derivable from the album URL/ID alone without
 * either an API key (flickr.photosets.getInfo) or a live request. Flickr's
 * public oEmbed endpoint (no API key needed) accepts a photo OR
 * album/set/gallery page URL and returns a thumbnail_url for it, so that's
 * what this calls. Doing that server-render-side for every album on every
 * Graphics tab load would mean N extra Worker subrequests to an external
 * host stacked onto one page render — exactly the failure mode documented
 * throughout this file's siblings (see round-recap's own doc comment, and
 * PERFORMANCE_AUDIT.md) that's caused real Cloudflare "too many subrequests"
 * errors on this site before. Splitting it into its own route means each
 * album's fetch happens as its own separate request, fired lazily
 * client-side (src/pages/media.astro's own script) once that card is
 * actually on screen, same "stale-first, live-patch-after" shape as
 * round-recap and driver-career-totals — the card renders with a plain
 * placeholder immediately, then swaps in a real thumbnail if/when this
 * resolves.
 *
 * Only ever attempts Flickr's oEmbed — any other host returns a null
 * thumbnail immediately with no outbound request, since "usually Flickr" is
 * the one shape worth handling and Flickr's endpoint won't resolve a
 * non-Flickr URL anyway. A long cache: an album's cover essentially never
 * changes once a photographer sets one.
 */
export const GET: APIRoute = async ({ url }) => {
  const albumUrl = url.searchParams.get('url');
  if (!albumUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(albumUrl);
  } catch {
    return new Response(JSON.stringify({ thumbnailUrl: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Not Flickr (or not http/https) — no point calling an endpoint that only
  // ever resolves flickr.com pages.
  if (!/(^|\.)flickr\.com$/i.test(parsed.hostname) || !/^https?:$/.test(parsed.protocol)) {
    return new Response(JSON.stringify({ thumbnailUrl: null }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  }

  try {
    const oembedUrl = `https://www.flickr.com/services/oembed/?format=json&url=${encodeURIComponent(albumUrl)}`;
    const res = await fetch(oembedUrl);
    if (!res.ok) {
      return new Response(JSON.stringify({ thumbnailUrl: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const data = (await res.json()) as { thumbnail_url?: string };
    return new Response(JSON.stringify({ thumbnailUrl: data.thumbnail_url ?? null }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Album covers essentially never change once set — cache long, both
        // at the edge and in the requesting browser.
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    console.error('Failed to fetch Flickr oEmbed thumbnail:', err);
    return new Response(JSON.stringify({ thumbnailUrl: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
