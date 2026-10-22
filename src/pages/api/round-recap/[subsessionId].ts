import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../../lib/db/client';
import { computeRoundRecap } from '../../../lib/newsRecap';

export const prerender = false;

/**
 * A round's computeRoundRecap() (src/lib/newsRecap.ts), by subsession_id, for "Race Recaps at this Layout".
 * About 8 queries each, so recaps load only when a visitor expands one. Public data.
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
        // Short edge cache: recaps only change when an old round's penalty changes.
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
