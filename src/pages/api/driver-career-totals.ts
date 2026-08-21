import type { APIRoute } from 'astro';
import { resolveSupabaseEnv, getSeasons, getDriverClasses, getStandingsExcludedRoundIds } from '../../lib/supabase';
import { computeDriverCareerStats } from '../../lib/results';

export const prerender = false;

/**
 * JSON endpoint behind the Roster page's Starts/Seasons columns (src/pages/
 * roster.astro) — {driverId: {starts, seasonsCount}} for every driver who's
 * ever scored in a championship season, straight off the same
 * computeDriverCareerStats() the Driver Stats page uses, so the two pages
 * can never quietly disagree on what "23 starts, across 4 seasons" means
 * for the same driver.
 *
 * Why this isn't just `drivers.starts`/`drivers.seasons_count`: those two
 * columns are NOT kept in sync by anything in this app — no import job,
 * trigger, or admin action ever writes to them. The only place they're
 * ever set is generate_seed.py's one-time CSV upsert (see that script's own
 * writer), a manual spreadsheet snapshot Logan re-generates by hand. That's
 * exactly why they were reported as "missing statistics" for a lot of
 * drivers — anyone who raced since the last time that seed was regenerated
 * and re-applied simply never got their counts bumped. Rather than trying
 * to wire up yet another place that has to remember to update them (the
 * same trap `drivers.penalty_points` was already in — see
 * computeSeasonPPState's own doc comment on roster.astro for that exact
 * story), this recomputes both figures live, the same fix already applied
 * there.
 *
 * Deliberately a separate lazy fetch rather than computed inline in
 * roster.astro's own frontmatter: computeDriverCareerStats() is the single
 * most expensive computation in this app (it's WHY driver-stats.astro and
 * team-stats.astro had to move to a shell-then-fragment split in the first
 * place — see PERFORMANCE_AUDIT.md #5 and the Cloudflare Workers
 * subrequest-limit incidents referenced throughout this file). Roster
 * already renders synchronously and stays fast doing it; bolting this
 * computation onto that same request risked reintroducing that exact
 * failure mode on a second page. Fetched once, client-side, after the
 * roster table has already painted with whatever the stored columns say —
 * src/pages/roster.astro's own script swaps in the live numbers once this
 * resolves. Public/no admin gating, same reasoning as round-recap's own API
 * route: this is the same publicly-computable data Driver Stats already
 * shows anyone, just reachable directly and pre-aggregated for every driver
 * at once instead of one card's expandable detail at a time.
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
