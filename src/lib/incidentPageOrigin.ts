/**
 * Where a visitor came to a round's incident page from (BR2.3-BR2.6), carried as `?from=reporting` in the
 * page address so it survives view changes and is part of the edge-cache key. Only that exact value counts;
 * anything else is treated as no origin.
 */

export const INCIDENT_ORIGIN_PARAM = 'from';
export const REPORTING_ORIGIN = 'reporting';

export type IncidentOrigin = typeof REPORTING_ORIGIN | null;

/** The origin from a page's parameters, or from the first `from` value itself (BR2.4). */
export function parseIncidentOrigin(source: URLSearchParams | string | null | undefined): IncidentOrigin {
  const value = source instanceof URLSearchParams ? source.get(INCIDENT_ORIGIN_PARAM) : source;
  return value === REPORTING_ORIGIN ? REPORTING_ORIGIN : null;
}

/** The page's one back link (BR2.3): the Incident Reporting list, or the round's results page. */
export function incidentBackLink(
  origin: IncidentOrigin,
  resultsHref: string,
): { label: string; href: string } {
  return origin === REPORTING_ORIGIN
    ? { label: '← Back to Incident Reports', href: '/admin/incident-reporting' }
    : { label: '← Back to Results', href: resultsHref };
}

/** `href` with `from=reporting` added when the origin is set, keeping its other parameters and hash (BR2.5). */
export function withIncidentOrigin(href: string, origin: IncidentOrigin): string {
  if (origin !== REPORTING_ORIGIN) return href;
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const params = new URLSearchParams(queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '');
  params.set(INCIDENT_ORIGIN_PARAM, REPORTING_ORIGIN);
  return `${path}?${params.toString()}${hash}`;
}
