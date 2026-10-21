import type { IncidentActionContext, IncidentActionRedirect } from './context';

/**
 * Where the round-penalty forms redirect: back to `anchor`, or to the top of the page with
 * ?roundpenalty=failed, which drives the flash there; a successful save clears one left over from an
 * earlier failure.
 */
export function roundPenaltyBack(ctx: IncidentActionContext, anchor: string, failed: boolean): IncidentActionRedirect {
  const { shellPath } = ctx;
  const url = new URL(ctx.url);
  if (failed) url.searchParams.set('roundpenalty', 'failed');
  else url.searchParams.delete('roundpenalty');
  return ctx.redirect(`${shellPath}${url.search}${failed ? '' : `#${anchor}`}`);
}
