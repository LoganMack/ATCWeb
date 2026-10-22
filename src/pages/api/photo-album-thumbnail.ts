import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * `{ thumbnailUrl }` for a photo album URL (`?url=`), for the Media page's Graphics tab. Flickr's cover URL
 * can't be derived from the album URL, so this asks Flickr's keyless oEmbed endpoint. A separate lazy request
 * per album keeps those external calls out of the page render and its subrequest budget. Non-Flickr URLs
 * return null without a request; cached long.
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
    // Only hand back https URLs on Flickr's own image hosts — the value ends
    // up in an <img src>, so never pass through anything else.
    let thumb: string | null = null;
    try {
      const t = new URL(String(data.thumbnail_url ?? ''));
      if (t.protocol === 'https:' && /(^|\.)(staticflickr|flickr)\.com$/i.test(t.hostname))
        thumb = t.toString();
    } catch {
      thumb = null;
    }
    return new Response(JSON.stringify({ thumbnailUrl: thumb }), {
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
