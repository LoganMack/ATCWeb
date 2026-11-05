/**
 * The Reported Incidents screen (FR1.1-FR1.6; BR1.1-BR1.3, BR1.5, BR1.6): one filter bar over one list with no
 * collapsible sections, the action order, desktop-only media with phone icon buttons, the shared review
 * visibility rule, and involved stewards' status buttons hidden.
 */
import { describe, expect, it } from 'vitest';
import { FILTER_ORDER } from '../../src/lib/incidentReportFilters';

const SRC = import.meta.glob('/src/**/*.{astro,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FRAGMENT = SRC['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const SHELL = SRC['/src/pages/results/[subsessionId]/incidents.astro'];
const list = FRAGMENT.slice(
  FRAGMENT.indexOf('{showIncidentList && ('),
  FRAGMENT.indexOf('data-admin-submissions'),
);

describe('the filter bar', () => {
  it('renders the five filters in order as pressed-state buttons with counts', () => {
    expect(list).toContain(
      '<div role="group" aria-label="Filter submissions" class="flex flex-wrap gap-2" data-incident-filters>',
    );
    expect(list).toContain("class={`btn btn-sm ${f === activeFilter ? 'btn-active' : 'btn-neutral'}`}");
    expect(list).toContain("aria-pressed={f === activeFilter ? 'true' : 'false'}");
    expect(list).toContain('{FILTER_LABELS[f]} ({filterCounts[f]})');
    expect(list).toContain('data-testid={`incident-filter-${f}`}');
    expect(FILTER_ORDER).toEqual(['needs_review', 'reviewed', 'decided', 'dismissed', 'appeals']);
    expect(list).toContain('{FILTER_ORDER.map((f) => (');
  });

  it('puts every report and appeal in one list, hiding the cards outside the first filter', () => {
    expect(list.match(/<ul class="flex flex-col gap-2" data-incident-list>/g)).toHaveLength(1);
    expect(list).toContain('hidden={filterGroup !== activeFilter}');
    expect(list).toContain('data-filter-group="appeals"');
    expect(list).toContain("hidden={viewReports && activeFilter !== 'appeals'}");
    expect(list).toContain('data-filter-empty={f}');
    expect(FRAGMENT).toContain('const activeFilter = initialFilter(filterCounts);');
  });

  it('has no collapsible sections for the report groups or appeals', () => {
    expect(list).not.toContain('<details open');
    expect(FRAGMENT).not.toContain('reportGroups');
    expect(FRAGMENT).not.toMatch(/<details open=\{incidentAppeals/);
  });

  it('loads its script from the shell page', () => {
    expect(SHELL).toContain("import '../../../scripts/incidentFilters';");
  });
});

describe('the report card', () => {
  it('orders the actions with Add/Edit Review after Add to Report and before Dismiss', () => {
    const order = [
      list.indexOf('View Decision'),
      list.indexOf('data-open-video'),
      list.indexOf('data-open-report-map'),
      list.search(/>\s*Edit Submission\s*</),
      list.indexOf('data-testid="report-edit-video"'),
      list.search(/>\s*Add to Report\s*</),
      list.indexOf('data-open-review-dialog'),
      list.indexOf('data-open-dismiss-dialog'),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('hides the phone icon buttons on desktop, where the clip and map sit beside the text', () => {
    expect(list.match(/class=\{`\$\{reportIconBtn\} lg:hidden`\}/g)).toHaveLength(2);
    expect(list).toContain('class="hidden flex-none items-start gap-3 lg:flex" data-report-media');
    // FR1.6: the clip and map sit above the action buttons, which run full width below them.
    expect(list.indexOf('data-report-media')).toBeLessThan(list.indexOf('data-report-actions'));
    expect(list).toMatch(/data-inline-clip=\{r\.video_url\}/);
    expect(list).toMatch(
      /<img class="layout-map-img" src=\{reportMapUrl\} alt="" decoding="async" loading="lazy" \/>/,
    );
  });

  it('hides Add to Report, Dismiss and Reopen from a steward involved in the report', () => {
    expect(list).toContain("{r.status === 'open' && !involved && (");
    expect(list).toContain("{involved ? null : r.status === 'open' ? (");
  });

  it('decides who sees other reviews with the shared rule', () => {
    expect(list).toContain(
      'const canSeeReviews = canSeeReviewsFor(r, { reviewedByMe: Boolean(myReview), involved });',
    );
    expect(FRAGMENT).not.toContain('Boolean(myReview) || reviewsLocked || involved');
  });

  it('explains a status change the database refused for an involved steward', () => {
    expect(SRC['/src/lib/incidentActions/setReportStatus.ts']).toContain("includes('INVOLVED_STEWARD')");
    expect(FRAGMENT).toContain("flash === 'statusinvolved'");
  });
});

describe('the inline clip script (BR1.5)', () => {
  const script = SRC['/src/scripts/incidentFilters.ts'];

  it('builds players on desktop only, once each card is near the screen', () => {
    expect(script).toContain("const DESKTOP = '(min-width: 1024px)';");
    expect(script).toContain('window.matchMedia(DESKTOP).matches');
    expect(script).toContain('new IntersectionObserver(');
    expect(script).toContain('buildClipPlayer(document, ');
  });
});
