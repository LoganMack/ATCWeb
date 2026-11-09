/**
 * The Reported Incidents filters (FR1.1-FR1.3; BR1.1-BR1.3): which filter a report belongs to, which filter
 * opens first, and when the other stewards' reviews may be shown.
 */
import { describe, expect, it } from 'vitest';
import {
  FILTER_EMPTY,
  FILTER_LABELS,
  FILTER_ORDER,
  canSeeReviews,
  countFilters,
  filterGroupOf,
  initialFilter,
} from '../../src/lib/incidentReportFilters';

const viewer = { reviewedByMe: false, involved: false, reviewsLoadFailed: false };
const open = { status: 'open', reviews_closed_at: null };

describe('filterGroupOf (BR1.2)', () => {
  it('puts an open report the steward has not reviewed in Needs Review', () => {
    expect(filterGroupOf(open, viewer)).toBe('needs_review');
  });

  it('moves an open report to Reviewed once reviewed, closed for reviews, or when the steward is involved', () => {
    expect(filterGroupOf(open, { ...viewer, reviewedByMe: true })).toBe('reviewed');
    expect(filterGroupOf({ ...open, reviews_closed_at: '2026-11-01T00:00:00Z' }, viewer)).toBe('reviewed');
    expect(filterGroupOf(open, { ...viewer, involved: true })).toBe('reviewed');
  });

  it('files decided and dismissed reports by status whatever the reviews say', () => {
    expect(filterGroupOf({ ...open, status: 'logged' }, { ...viewer, reviewedByMe: true })).toBe('decided');
    expect(filterGroupOf({ ...open, status: 'dismissed' }, { ...viewer, involved: true })).toBe('dismissed');
    expect(filterGroupOf({ ...open, status: 'logged' }, { ...viewer, reviewsLoadFailed: true })).toBe(
      'decided',
    );
  });

  it('keeps open reports in Needs Review when the reviews could not be read', () => {
    expect(filterGroupOf(open, { reviewedByMe: true, involved: true, reviewsLoadFailed: true })).toBe(
      'needs_review',
    );
  });
});

describe('initialFilter (BR1.3)', () => {
  it('opens on the first filter in button order that has something in it', () => {
    expect(initialFilter({ needs_review: 2, reviewed: 1 })).toBe('needs_review');
    expect(initialFilter({ reviewed: 0, decided: 3, appeals: 1 })).toBe('decided');
    expect(initialFilter({ appeals: 1 })).toBe('appeals');
  });

  it('falls back to Needs Review when every filter is empty', () => {
    expect(initialFilter({})).toBe('needs_review');
    expect(initialFilter(countFilters([]))).toBe('needs_review');
  });
});

describe('initialFilter with open appeals (appeals BR1.1)', () => {
  it('opens on Appeals while any appeal is open, even ahead of reports needing review', () => {
    expect(initialFilter({ needs_review: 4, appeals: 2 }, 1)).toBe('appeals');
    expect(initialFilter({}, 3)).toBe('appeals');
  });

  it('keeps the button-order rule when every appeal is closed or dismissed', () => {
    expect(initialFilter({ reviewed: 1, appeals: 2 }, 0)).toBe('reviewed');
    expect(initialFilter({ appeals: 2 }, 0)).toBe('appeals');
  });
});

describe('countFilters', () => {
  it('counts every filter, including ones with nothing in them', () => {
    expect(countFilters(['reviewed', 'appeals', 'reviewed'])).toEqual({
      needs_review: 0,
      reviewed: 2,
      decided: 0,
      dismissed: 0,
      appeals: 1,
    });
  });

  it('has a label and an empty message for every filter in order', () => {
    expect(FILTER_ORDER.map((f) => FILTER_LABELS[f])).toEqual([
      'Needs Review',
      'Reviewed',
      'Decided',
      'Dismissed',
      'Appeals',
    ]);
    for (const f of FILTER_ORDER) expect(FILTER_EMPTY[f]).toMatch(/\.$/);
  });
});

describe('canSeeReviews (BR1.1)', () => {
  it('keeps the vote blind until the steward has reviewed', () => {
    expect(canSeeReviews(open, viewer)).toBe(false);
    expect(canSeeReviews(open, { reviewedByMe: true, involved: false })).toBe(true);
  });

  it('shows reviews once they are closed', () => {
    expect(canSeeReviews({ ...open, reviews_closed_at: '2026-11-01T00:00:00Z' }, viewer)).toBe(true);
  });

  it('shows an involved steward the reviews of a dismissed report only', () => {
    expect(canSeeReviews({ ...open, status: 'dismissed' }, { reviewedByMe: false, involved: true })).toBe(
      true,
    );
    expect(canSeeReviews(open, { reviewedByMe: false, involved: true })).toBe(false);
    expect(canSeeReviews({ ...open, status: 'logged' }, { reviewedByMe: false, involved: true })).toBe(false);
    expect(canSeeReviews({ ...open, status: 'dismissed' }, viewer)).toBe(false);
  });
});
