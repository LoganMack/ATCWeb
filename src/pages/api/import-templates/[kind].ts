import type { APIRoute } from 'astro';
import { getImportTemplateCsv } from '../../../lib/importTemplates';

export const prerender = false;

/**
 * Serves the "Download CSV template" links on /admin/import — generated
 * from src/lib/importTemplates.ts rather than a static file under public/,
 * so the download always reflects whatever columns each importer currently
 * reads (see that file's own header comment for why this replaced 4 static
 * .csv files). Not admin-gated: the content is just an empty-data example,
 * same as the static files it replaced, which were unauthenticated too.
 */
export const GET: APIRoute = async ({ params }) => {
  // The admin page's download links point at `/api/import-templates/${kind}.csv`
  // (so the link itself reads like a real filename) — this is a single
  // dynamic segment route ([kind].ts), so params.kind arrives as e.g.
  // "events.csv", not "events". Strip a trailing .csv before looking it up,
  // otherwise every request 404s here (which is why "download" was
  // producing a "File wasn't available on site" error in the browser).
  const kind = String(params.kind ?? '').replace(/\.csv$/i, '');
  const csv = getImportTemplateCsv(kind);
  if (!csv) {
    return new Response('Unknown import template', { status: 404 });
  }
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${kind}-import-template.csv"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
};
