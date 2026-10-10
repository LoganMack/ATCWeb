/**
 * Reporting windows the admin dashboard's Site Analytics can be loaded for —
 * the dashboard renders one button per entry (admin/fragment.astro) and
 * admin/analytics/fragment.astro resolves its `?range=` param back through
 * resolveAnalyticsRange. `days` is passed straight to get_page_view_stats()'s
 * p_days (0103_page_view_stats_performance.sql); null means all time.
 */
export interface AnalyticsRange {
  key: string;
  /** Button text. */
  label: string;
  /** Lowercase, for chart titles: "Top Regions (90 days)". */
  title: string;
  /** Ends "No errors recorded …". */
  emptyErrors: string;
  days: number | null;
}

export const ANALYTICS_RANGES: AnalyticsRange[] = [
  { key: '30', label: '30 Days', title: '30 days', emptyErrors: 'in the last 30 days', days: 30 },
  { key: '90', label: '90 Days', title: '90 days', emptyErrors: 'in the last 90 days', days: 90 },
  { key: '365', label: '1 Year', title: '1 year', emptyErrors: 'in the last year', days: 365 },
  { key: 'all', label: 'All Time', title: 'all time', emptyErrors: 'yet', days: null },
];

/** Unknown or missing keys fall back to 30 days, the original fixed window. */
export function resolveAnalyticsRange(key: string | null): AnalyticsRange {
  return ANALYTICS_RANGES.find((r) => r.key === key) ?? ANALYTICS_RANGES[0];
}
