import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../lib/db/client';
import { getSeasons } from '../../lib/db/seasons';
import { getDriverClasses } from '../../lib/db/lookups';
import { getStandingsExcludedRoundIds } from '../../lib/db/rounds';
import { computeDriverCareerStats } from '../../lib/results/careerStats';

export const prerender = false;

/**
 * {driverId: {starts, seasonsCount}} for the Roster's Starts/Seasons columns, from the same
 * computeDriverCareerStats() as Driver Stats so the two agree. `drivers.starts`/`seasons_count` are only set
 * by the seed script and go stale. Fetched lazily after the roster paints, because that computation is the
 * app's most expensive and would slow the roster page. Public data.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const supabaseEnv = resolveSupabaseEnv(locals);
    const [seasons, classes, exhibitionRoundIds] = await Promise.all([
      getSeasons(supabaseEnv),
      getDriverClasses(supabaseEnv),
      getStandingsExcludedRoundIds(supabaseEnv),
    ]);
    const careerStats = await computeDriverCareerStats(supabaseEnv, seasons, classes, exhibitionRoundIds);

    const totals: Record<string, { starts: number; seasonsCount: number }> = {};
    for (const entry of careerStats) {
      totals[entry.driver.id] = { starts: entry.starts, seasonsCount: entry.seasons.length };
    }

    return new Response(JSON.stringify(totals), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Same edge-cache window every other computed-on-the-fly page on
        // this site uses (roster.astro itself included) — new results land
        // within about a minute without every roster visit re-running this.
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('Failed to compute driver career totals for roster:', err);
    return new Response(JSON.stringify({ error: 'Failed to compute driver career totals' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
