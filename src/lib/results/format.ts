// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** e.g. pctOf(4, 12) -> "33% of starts". Returns an em dash when the denominator is 0. */
export function pctOf(count: number, denominator: number, ofWhat: string): string {
  if (denominator <= 0) return '—';
  return `${Math.round((count / denominator) * 100)}% of ${ofWhat}`;
}

/**
 * Converts iRacing's `interval_ten_thousandths` gap-to-leader into "xx.xxx"
 * seconds. The leader's own gap is 0 by definition, which isn't a
 * meaningful "margin" to show next to their name — that (and a missing
 * interval) both display as "—" instead of "0.000".
 *
 * A negative interval (iRacing typically reports this as displaying like
 * "-0.000") isn't a real time gap — it's iRacing's way of flagging that this
 * driver finished one or more laps down rather than close behind on the
 * same lap (Logan: "most likely a lap down or more"). When that happens,
 * `ownLaps`/`leaderLaps` (both from `curated_race_results.laps_complete`)
 * are used to show "-xL" (x laps down) instead of a bogus time gap.
 *
 * `leaderIntervalTenThousandths` lets a caller measure against someone OTHER
 * than the row this interval is naturally zeroed against — namely the Per
 * Class view, which wants "distance to the class leader" rather than
 * "distance to the overall race leader." Every `interval_ten_thousandths`
 * in a race shares the same fixed reference point (the overall leader), so
 * as long as both this row's and the alternate leader's intervals are real,
 * non-negative time gaps, their difference is exactly the gap between the
 * two of them. Defaults to 0 (the overall leader's own gap to themselves),
 * reproducing the original overall-leader behavior exactly. A null or
 * negative value here means there's no usable time-based reference (the
 * alternate leader is themselves laps down against the overall leader), so
 * this falls back to the laps-down comparison only.
 */
export function formatMargin(
  intervalTenThousandths: number | null,
  ownLaps: number | null,
  leaderLaps: number | null,
  leaderIntervalTenThousandths: number | null = 0,
): string {
  if (intervalTenThousandths === null) return '—';
  const hasValidOffset = leaderIntervalTenThousandths !== null && leaderIntervalTenThousandths >= 0;
  if (intervalTenThousandths < 0 || !hasValidOffset) {
    if (ownLaps !== null && leaderLaps !== null && leaderLaps > ownLaps) {
      return `-${leaderLaps - ownLaps}L`;
    }
    return '—';
  }
  if (intervalTenThousandths === leaderIntervalTenThousandths) return '—';
  return ((intervalTenThousandths - (leaderIntervalTenThousandths as number)) / 10000).toFixed(3);
}

/** Builds the URL for a race's results on iRacing's own site from its real iRacing subsession id (see `race_links` / 0007_race_links.sql — NOT the same as this app's own `subsession_id` grouping key). */
export function iracingResultsUrl(iracingSubsessionId: number): string {
  return `https://members-ng.iracing.com/web/racing/results-stats/results?subsessionid=${iracingSubsessionId}`;
}
