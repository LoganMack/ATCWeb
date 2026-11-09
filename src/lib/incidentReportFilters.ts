/**
 * The Reported Incidents screen's filters (FR1.1-FR1.3; BR1.1-BR1.3): which filter each report belongs to, which
 * filter is selected when the page loads, and when a steward may see the other stewards' reviews. Pure, so the
 * page and its tests share one rule; the database enforces the review rule itself (BR1.1, BR1.6).
 */

export type IncidentFilter = 'needs_review' | 'reviewed' | 'decided' | 'dismissed' | 'appeals';
export type ReportFilter = Exclude<IncidentFilter, 'appeals'>;

/** The button order, which is also the order the initial filter is picked in (BR1.3). */
export const FILTER_ORDER: readonly IncidentFilter[] = [
  'needs_review',
  'reviewed',
  'decided',
  'dismissed',
  'appeals',
];

export const FILTER_LABELS: Record<IncidentFilter, string> = {
  needs_review: 'Needs Review',
  reviewed: 'Reviewed',
  decided: 'Decided',
  dismissed: 'Dismissed',
  appeals: 'Appeals',
};

/** What the list says when the selected filter has nothing in it. */
export const FILTER_EMPTY: Record<IncidentFilter, string> = {
  needs_review: 'No reports need your review.',
  reviewed: 'No reviewed reports.',
  decided: 'No reports have been added to the incident report.',
  dismissed: 'No dismissed reports.',
  appeals: 'No appeals have been submitted.',
};

export interface FilterReport {
  status: 'open' | 'logged' | 'dismissed' | string;
  reviews_closed_at: string | null;
}

export interface FilterViewer {
  /** The viewer has their own review of this report. */
  reviewedByMe: boolean;
  /** The viewer's driver is one of the report's cars. */
  involved: boolean;
  /** The reviews could not be read, so open reports can't be split by review. */
  reviewsLoadFailed: boolean;
}

/** The one filter a report belongs to (BR1.2). */
export function filterGroupOf(report: FilterReport, viewer: FilterViewer): ReportFilter {
  if (report.status === 'dismissed') return 'dismissed';
  if (report.status === 'logged') return 'decided';
  if (viewer.reviewsLoadFailed) return 'needs_review';
  if (viewer.reviewedByMe || report.reviews_closed_at || viewer.involved) return 'reviewed';
  return 'needs_review';
}

/**
 * The filter selected on load: Appeals while any appeal is open (appeals BR1.1), otherwise the first one with
 * something in it, else Needs Review (BR1.3).
 */
export function initialFilter(
  counts: Partial<Record<IncidentFilter, number>>,
  openAppeals = 0,
): IncidentFilter {
  if (openAppeals > 0) return 'appeals';
  return FILTER_ORDER.find((f) => (counts[f] ?? 0) > 0) ?? 'needs_review';
}

/** Counts per filter, every filter present. */
export function countFilters(groups: Iterable<IncidentFilter>): Record<IncidentFilter, number> {
  const counts: Record<IncidentFilter, number> = {
    needs_review: 0,
    reviewed: 0,
    decided: 0,
    dismissed: 0,
    appeals: 0,
  };
  for (const g of groups) counts[g] += 1;
  return counts;
}

/**
 * Whether the viewer may see the other stewards' reviews and their agreement colour, mirroring the database's
 * read rule (BR1.1): their own review, reviews closed, or involved in a dismissed report. Others' reviews of a
 * report the viewer has not reviewed stay hidden so the vote stays blind.
 */
export function canSeeReviews(
  report: FilterReport,
  viewer: Pick<FilterViewer, 'reviewedByMe' | 'involved'>,
): boolean {
  return (
    viewer.reviewedByMe ||
    Boolean(report.reviews_closed_at) ||
    (viewer.involved && report.status === 'dismissed')
  );
}
