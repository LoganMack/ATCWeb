import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../../lib/db/client';
import { getSeriesRatingHistory, isRatingDriverKey, resolveRatingKind } from '../../../lib/db/seriesRatings';

export const prerender = false;

/**
 * One driver's Series iRating history for the chart a list row opens (src/scripts/seriesRatings.ts), read
 * only on expand so the list itself keeps its 20 trend values per driver (NFR2). Keyed on `class` and `driver`
 * (the list's opaque key), both edge-cached; a hidden driver is only ever found by their stand-in key.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const driver = url.searchParams.get('driver');
  const json = (body: unknown, status: number, cache: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
    });

  if (!isRatingDriverKey(driver)) return json({ error: 'Unknown driver' }, 400, 'no-store');

  try {
    const steps = await getSeriesRatingHistory(
      resolveSupabaseEnv(locals),
      resolveRatingKind(url.searchParams.get('class')),
      driver,
    );
    // The same lifetime as the list, so an opened chart never runs ahead of the row it belongs to.
    return json({ steps }, 200, 'public, s-maxage=60, stale-while-revalidate=300');
  } catch (err) {
    console.error('Failed to load a Series iRating history:', err);
    return json({ error: 'Failed to load the rating history' }, 500, 'no-store');
  }
};
