import type { APIRoute } from 'astro';
import { resolveSupabaseEnv } from '../../lib/db/client';
import { getSeasons } from '../../lib/db/seasons';
import { getExhibitionRoundIds, getTestRoundIds } from '../../lib/db/rounds';
import { getRoundsForSeason, computeDisplayRoundNumbers } from '../../lib/results/rounds';
import { isChampionshipSeason } from '../../lib/results/shared';

export const prerender = false;

/**
 * JSON endpoint behind the Results dropdown in the top nav (src/components/Nav.astro):
 * the current season's rounds, newest first, as `{ id, round, track }`. Loaded the
 * first time a visitor hovers the Results link rather than on every page render,
 * since the nav appears on every page and almost no visits open that menu.
 *
 * Same round list the Results page shows by default: championship seasons leave out
 * exhibition and test rounds, and "Round N" is the app's own per-season numbering
 * (computeDisplayRoundNumbers). Public data, so no auth.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = resolveSupabaseEnv(locals);
    const seasons = await getSeasons(env);
    const season = seasons.find((s) => s.is_current) ?? seasons[0];
    if (!season) {
      return json([], 60);
    }

    const [seasonRounds, exhibitionRoundIds, testRoundIds] = await Promise.all([
      getRoundsForSeason(env, season.id),
      getExhibitionRoundIds(env),
      getTestRoundIds(env),
    ]);
    const displayRoundNumbers = computeDisplayRoundNumbers(seasonRounds, exhibitionRoundIds, testRoundIds);
    const rounds = isChampionshipSeason(season.name)
      ? seasonRounds.filter(
          (r) => !exhibitionRoundIds.has(r.subsession_id) && !testRoundIds.has(r.subsession_id),
        )
      : seasonRounds;

    const out = [...rounds]
      .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
      .map((r) => ({
        id: r.subsession_id,
        round: displayRoundNumbers.get(r.subsession_id) ?? null,
        track: r.track_name,
      }));
    return json(out, 300);
  } catch (err) {
    console.error('Failed to load rounds for the nav Results menu:', err);
    return new Response(JSON.stringify({ error: 'Failed to load rounds' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

function json(body: unknown, sMaxAge: number) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${sMaxAge}, stale-while-revalidate=600`,
    },
  });
}
