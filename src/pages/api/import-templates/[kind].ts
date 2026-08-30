import type { APIRoute } from 'astro';
import { getImportTemplateCsv, type RoundColumnPrefill } from '../../../lib/importTemplates';
import { resolveSupabaseEnv, getSeasons } from '../../../lib/supabase';
import { getEventsMissingResults, suggestImportKey } from '../../../lib/raceResultsImport';

export const prerender = false;

const RESULT_KINDS = new Set(['race-results', 'qualifying-results', 'practice-results']);

/**
 * Serves the "Download CSV template" links on /admin/import — generated
 * from src/lib/importTemplates.ts rather than a static file under public/,
 * so the download always reflects whatever columns each importer currently
 * reads (see that file's own header comment for why this replaced 4 static
 * .csv files). Not admin-gated: the content is just an empty-data example,
 * same as the static files it replaced, which were unauthenticated too.
 *
 * When a signed-in admin downloads one of the three results templates for a
 * specific event (?eventId=... — Admin > Add Race Result's per-event upload
 * buttons), the round-identifying columns (circuit_name, layout,
 * season_name, event_date, event_time, format, exhibition) are pre-filled
 * from that event, and import_key is pre-filled with the existing manual
 * round's key if this event already has one linked (so uploading, say, a
 * qualifying template for an event that already has a race result attaches
 * to that SAME round instead of creating a new one) — see
 * getEventsMissingResults()/suggestImportKey() in raceResultsImport.ts. An
 * anonymous request, or an eventId that isn't actually missing anything
 * (kind/eventId combination is stale), just gets the plain unfilled
 * template, same as before this existed.
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  // The admin page's download links point at `/api/import-templates/${kind}.csv`
  // (so the link itself reads like a real filename) — this is a single
  // dynamic segment route ([kind].ts), so params.kind arrives as e.g.
  // "events.csv", not "events". Strip a trailing .csv before looking it up,
  // otherwise every request 404s here (which is why "download" was
  // producing a "File wasn't available on site" error in the browser).
  const kind = String(params.kind ?? '').replace(/\.csv$/i, '');

  const eventId = url.searchParams.get('eventId');
  const accessToken = locals.session?.accessToken;
  let prefill: RoundColumnPrefill | undefined;

  if (eventId && accessToken && RESULT_KINDS.has(kind)) {
    try {
      const env = resolveSupabaseEnv(locals);
      const events = await getEventsMissingResults(env, accessToken);
      const ev = events.find((e) => e.eventId === eventId);
      if (ev) {
        const startTimeByKind: Record<string, string | null> = {
          'race-results': ev.raceStartTime,
          'qualifying-results': ev.qualifyingStartTime,
          'practice-results': ev.practiceStartTime,
        };

        // Test/Exhibition events have no season_id of their own (see
        // EventCategory's doc comment in src/lib/supabase.ts) — fall back to
        // whichever season is current, the same guess an admin filling this
        // in by hand would make. Still just a starting point either way.
        let seasonName = ev.seasonName;
        if (!seasonName) {
          try {
            const seasons = await getSeasons(env);
            seasonName = seasons.find((s) => s.is_current)?.name ?? null;
          } catch (err) {
            console.error('Failed to look up the current season for a template prefill:', err);
          }
        }

        prefill = {
          import_key: ev.importKey ?? suggestImportKey(ev),
          circuit_name: ev.circuitName,
          layout: ev.layout ?? '',
          season_name: seasonName ?? '',
          event_date: ev.eventDate,
          event_time: (startTimeByKind[kind] ?? '').slice(0, 5),
          format: ev.format ?? '',
          status: 'official',
          strength_of_field: '',
          exhibition: ev.category === 'exhibition' ? 'yes' : 'no',
        };
      }
    } catch (err) {
      console.error('Failed to prefill an import template from its event context:', err);
    }
  }

  const csv = getImportTemplateCsv(kind, prefill);
  if (!csv) {
    return new Response('Unknown import template', { status: 404 });
  }
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-import-template.csv"`,
      // An event-specific download reflects one admin's in-progress
      // checklist, not a stable static asset — never cached, unlike the
      // plain template below.
      'Cache-Control': eventId ? 'no-store' : 'public, max-age=300',
    },
  });
};
