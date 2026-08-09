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
  const kind = String(params.kind ?? '');
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
