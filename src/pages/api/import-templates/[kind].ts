import type { APIRoute } from 'astro';
import { getImportTemplateCsv, type RoundColumnPrefill } from '../../../lib/importTemplates';
import { resolveSupabaseEnv } from '../../../lib/db/client';
import { getSeasons } from '../../../lib/db/seasons';
import { getEventsMissingResults, suggestImportKey } from '../../../lib/raceResultsImport';

export const prerender = false;

const RESULT_KINDS = new Set(['race-results', 'qualifying-results', 'practice-results']);

/**
 * The admin "Download CSV template" links, generated from src/lib/importTemplates.ts; an unknown kind
 * (including the removed circuits template) is a 404. Not admin-gated (empty
 * example data). For an admin downloading a results template for one event (?eventId=), the round columns are
 * prefilled from the event, import_key reuses the event's existing manual round, and exhibition/test come
 * from the event's category (the only way those flags are set for manual rounds). Otherwise the plain
 * template.
 */
export const GET: APIRoute = async ({ params, url, locals }) => {
  // Links read `/api/import-templates/<kind>.csv`, so params.kind includes ".csv"; strip it.
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

        // Test/exhibition events have no season (EventCategory in src/lib/db/events.ts), so suggest the
        // current one.
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
          strength_of_field: '',
          exhibition: ev.category === 'exhibition' ? 'yes' : 'no',
          test: ev.category === 'test' ? 'yes' : 'no',
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
