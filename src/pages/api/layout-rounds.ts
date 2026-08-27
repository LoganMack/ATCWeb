import type { APIRoute } from 'astro';
import { resolveSupabaseEnv, getCircuits, getAllCircuitLayouts } from '../../lib/supabase';
import { getAllRounds, getRoundLayoutsForSubsessions, findRoundsForLayout, type LayoutRoundSummary } from '../../lib/results';

export const prerender = false;

/**
 * JSON endpoint behind the calendar page's "Race Recaps at this Layout"
 * collapsible (src/components/EventDetailCard.astro + calendar.astro's own
 * client script) — returns the LIST of historical rounds run at one event's
 * circuit+layout (see findRoundsForLayout(), src/lib/results.ts), the same
 * list calendar.astro used to compute up front for every event on the page.
 *
 * Deliberately lazy/per-event rather than computed server-side for every
 * event card: with a full month of events (each potentially matching dozens
 * of historical rounds at a repeated circuit), eagerly rendering every
 * round's <details> for every card was measured to add hundreds of DOM
 * nodes to the page that most visitors never open — the exact "ships work
 * nobody asked for" problem src/pages/api/round-recap/[subsessionId].ts
 * already solved one level down (the recap CONTENT within a round). This
 * route does the same thing one level up, for the round LIST itself:
 * fetched client-side only once a visitor actually expands a given event's
 * "Race Recaps at this Layout" summary.
 *
 * No admin gating — this is the same publicly-viewable round history the
 * calendar page already lists for anyone, just computed on demand instead
 * of unconditionally for every event up front.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const circuitId = url.searchParams.get('circuitId');
  const layoutParam = url.searchParams.get('layout');
  // A missing `layout` query param and an event with a genuinely null
  // layout both mean the same thing here (no specific layout name on
  // file) — the URLSearchParams API can't distinguish "absent" from
  // "present but empty" on its own, so an empty string is also treated as
  // null, matching how EventDetailCard/calendar.astro already pass
  // event.layout (string | null) through.
  const layout = layoutParam && layoutParam.length > 0 ? layoutParam : null;

  if (!circuitId) {
    return new Response(JSON.stringify({ error: 'Missing circuitId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseEnv = resolveSupabaseEnv(locals);
    const [circuits, layouts, allRounds] = await Promise.all([
      getCircuits(supabaseEnv),
      getAllCircuitLayouts(supabaseEnv),
      getAllRounds(supabaseEnv),
    ]);
    const roundLayoutBySubsession = await getRoundLayoutsForSubsessions(
      supabaseEnv,
      allRounds.map((r) => r.subsession_id)
    );
    const rounds: LayoutRoundSummary[] = findRoundsForLayout(allRounds, roundLayoutBySubsession, circuits, layouts, circuitId, layout);

    return new Response(JSON.stringify(rounds), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Same short edge cache as round-recap — this list only changes
        // when a new round is imported or a circuit/layout is edited,
        // both rare — so repeat expand-clicks stay cheap without
        // meaningfully risking staleness.
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
