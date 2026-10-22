import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../lib/db/client';
import { getCircuits, getAllCircuitLayouts } from '../../lib/db/circuits';
import { getExhibitionRoundIds, getTestRoundIds } from '../../lib/db/rounds';
import { getAllRounds } from '../../lib/results/rounds';
import { getRoundLayoutsForSubsessions } from '../../lib/results/layoutLaps';
import { findRoundsForLayout, type LayoutRoundSummary } from '../../lib/results/layouts';

export const prerender = false;

/**
 * The round list for an event's "Race Recaps at this Layout" (findRoundsForLayout() in
 * src/lib/results/layouts.ts), fetched when a visitor expands it, because rendering every list for every
 * event added hundreds of unused DOM nodes. Public data.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const circuitId = url.searchParams.get('circuitId');
  const layoutParam = url.searchParams.get('layout');
  // A missing or empty `layout` both mean no layout name.
  const layout = layoutParam && layoutParam.length > 0 ? layoutParam : null;

  if (!circuitId) {
    return new Response(JSON.stringify({ error: 'Missing circuitId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseEnv = resolveSupabaseEnv(locals);
    const [circuits, layouts, allRounds, exhibitionRoundIds, testRoundIds] = await Promise.all([
      getCircuits(supabaseEnv),
      getAllCircuitLayouts(supabaseEnv),
      getAllRounds(supabaseEnv),
      // So each round gets its display "Round X".
      getExhibitionRoundIds(supabaseEnv),
      getTestRoundIds(supabaseEnv),
    ]);
    const roundLayoutBySubsession = await getRoundLayoutsForSubsessions(
      supabaseEnv,
      allRounds.map((r) => r.subsession_id),
    );
    const rounds: LayoutRoundSummary[] = findRoundsForLayout(
      allRounds,
      roundLayoutBySubsession,
      circuits,
      layouts,
      circuitId,
      layout,
      exhibitionRoundIds,
      testRoundIds,
    );

    return new Response(JSON.stringify(rounds), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short edge cache, as for round-recap: the list rarely changes.
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    console.error('Failed to compute layout rounds for API route:', err);
    return new Response(JSON.stringify({ error: 'Failed to compute layout rounds' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
