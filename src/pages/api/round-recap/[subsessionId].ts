import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../../lib/supabase';
import { computeRoundRecap } from '../../../lib/newsRecap';

export const prerender = false;

/**
 * JSON endpoint behind the event list's "Race Recaps at this Layout"
 * collapsible (src/components/EventDetailCard.astro + src/scripts/
 * roundRecap.ts) — returns the exact same computeRoundRecap() output a
 * linked news post's recap uses (see src/lib/newsRecap.ts), just reached
 * directly by subsession_id instead of via a post.
 *
 * Deliberately lazy/per-round rather than computed up front on the calendar
 * page: computeRoundRecap() is a genuinely expensive call (~8 queries), and
 * a circuit's layout can easily have been raced dozens of times across the
 * site's history — eagerly computing every one of those for every matching
 * event card on the calendar would multiply that cost by however many
 * historical rounds and event cards happen to be on the page at once,
 * risking the exact same Cloudflare Workers subrequest-limit failure mode
 * the homepage standings widget hit (see README). Fetched client-side only
 * once a visitor actually expands a given round.
 *
 * No admin gating — this is the same publicly-computable data the results
 * pages and news post recaps already show anyone, just reachable directly.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const subsessionId = Number(params.subsessionId);
  if (!Number.isFinite(subsessionId)) {
    return new Response(JSON.stringify({ error: 'Invalid subsession id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseEnv = resolveSupabaseEnv(locals);
    const recap = await computeRoundRecap(supabaseEnv, subsessionId);
    if (!recap) {
      return new Response(JSON.stringify({ error: 'Round not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(recap), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Recap content only changes when a penalty is logged/edited against
        // an old round, which is rare — a short edge cache keeps repeat
        // expand-clicks (and re-expanding after a collapse) cheap without
        // meaningfully risking staleness.
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    console.error('Failed to compute round recap for API route:', err);
    return new Response(JSON.stringify({ error: 'Failed to compute recap' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
