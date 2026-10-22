// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** e.g. pctOf(4, 12) -> "33% of starts". Returns an em dash when the denominator is 0. */
export function pctOf(count: number, denominator: number, ofWhat: string): string {
  if (denominator <= 0) return '—';
  return `${Math.round((count / denominator) * 100)}% of ${ofWhat}`;
}

/**
 * iRacing's gap-to-leader as "xx.xxx" seconds; the leader's own 0 and a missing interval show "—". A negative
 * interval means laps down, so `ownLaps`/`leaderLaps` give "-xL" instead. `leaderIntervalTenThousandths`
 * measures to another leader (the class leader in the Per Class view); every interval shares the overall
 * leader as reference, so a null or negative one falls back to laps down.
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

/**
 * "925.2 km" from a distance in km, to one decimal with halves rounded up. The small offset keeps an
 * exact .x5 total (stored in binary as .x4999…) rounding up, whatever order its laps were summed in.
 */
export function formatDistanceKm(km: number): string {
  return `${(Math.round(km * 10 + 1e-6) / 10).toFixed(1)} km`;
}
