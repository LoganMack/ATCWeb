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
    expect(FRAGMENT).toContain('const activeFilter = initialFilter(filterCounts, openAppealCount);');
    // Appeals BR1.1: the open appeals, not every appeal, decide whether the screen opens on Appeals.
    expect(FRAGMENT).toContain("const openAppealCount = incidentAppeals.filter((a) => a.status === 'open').length;");
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

describe('the appeal card (appeals BR1.2, BR1.3, BR5.1)', () => {
  const appealCard = list.slice(list.indexOf('{incidentAppeals.map((a) => {'), list.indexOf('{viewReports && FILTER_ORDER.map'));
  const actions = appealCard.slice(appealCard.indexOf('data-appeal-actions'));

  it('decides its buttons with the shared rule, including involvement', () => {
    expect(appealCard).toContain('const card = appealCardView(a, myComment !== null, isInvolvedInAppeal(appealed));');
  });

  it('shows each button only for the status that allows it', () => {
    expect(actions).toContain('{card.viewDecision && appealed && (');
    expect(actions).toContain('{card.dismiss && (');
    expect(actions).toContain('{card.closeAppeal && appealed && (');
    expect(actions).toContain('{card.commentLabel && (');
    expect(actions).toContain('{card.reopen && (');
    // Dismiss posts dismissed and Reopen posts open; nothing on the card posts reviewed (BR3.6).
    expect(actions).toContain('<input type="hidden" name="status" value="dismissed" />');
    expect(actions).toContain('<input type="hidden" name="status" value="open" />');
    expect(appealCard).not.toContain('value="reviewed"');
  });

  it('orders View Decision, Dismiss, Close Appeal, then Add/Edit Comment, at the lower right like the report card', () => {
    const order = [
      actions.indexOf('data-testid="appeal-view-decision"'),
      actions.indexOf('data-testid="appeal-dismiss"'),
      actions.indexOf('data-testid="appeal-close"'),
      actions.indexOf('data-testid="appeal-comment"'),
      actions.indexOf('data-testid="appeal-reopen"'),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(appealCard).toContain('<div class="mt-3 border-t border-white/10 pt-3">');
    expect(appealCard).toContain('<div class="flex flex-wrap items-center gap-2" data-appeal-actions>');
  });

  it('shows the steward comments collapsed, like the reviews, and the close record on a closed card', () => {
    expect(appealCard).toContain('<details class="group/comments min-w-0 flex-1" data-appeal-comments data-testid="appeal-comments">');
    expect(appealCard).toContain('<span>Steward comments ({appealComments.length})</span>');
    expect(appealCard).toContain('{card.outcome && (');
    expect(appealCard).toContain('Closed by {card.outcome.closedBy}');
  });

  it('uses the shared button classes only', () => {
    for (const button of actions.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/class="btn btn-(primary|danger|gold) btn-sm"/);
  });

  it('no longer offers Mark reviewed anywhere', () => {
    expect(FRAGMENT).not.toMatch(/Mark reviewed/i);
    expect(SRC['/src/lib/incidentActions/setAppealStatus.ts']).toContain("status === 'open' || status === 'dismissed'");
    expect(SRC['/src/lib/incidentActions/setAppealStatus.ts']).not.toContain("status === 'reviewed'");
  });

  it('registers the two new steward actions', () => {
    expect(FRAGMENT).toContain("['close-appeal', handleCloseAppeal],");
    expect(FRAGMENT).toContain("['save-appeal-comment', handleSaveAppealComment],");
  });
});

describe('the appeal popups (appeals BR2.2, BR3.1)', () => {
  const dialogOf = (attr: string) => {
    const start = FRAGMENT.search(new RegExp(`data-${attr}\\s`));
    return FRAGMENT.slice(start, FRAGMENT.indexOf('</dialog>', start));
  };

  it('has a Close Appeal popup with the penalty summary, four prefilled inputs and a required comment with a counter', () => {
    const dialog = dialogOf('decide-appeal-dialog');
    expect(dialog).toContain('data-testid="close-appeal-dialog"');
    expect(dialog).toContain('<input type="hidden" name="intent" value="close-appeal" />');
    expect(dialog).toContain('data-decide-appeal-summary');
    for (const name of ['time_penalty_seconds', 'points_penalty', 'penalty_points']) {
      expect(dialog).toMatch(new RegExp(`name="${name}"[\\s\\S]*?required[\\s\\S]*?min="0"`));
    }
    expect(dialog).toContain('step="0.001"');
    expect(dialog).toContain('name="is_warning"');
    expect(dialog).toMatch(/name="comment"[\s\S]*?required[\s\S]*?maxlength=\{APPEAL_COMMENT_MAX_LENGTH\}/);
    expect(dialog).toContain('data-decide-appeal-counter');
    // The Submit Appeal popup's Cancel buttons own data-close-appeal-dialog; nothing new may reuse it.
    expect(FRAGMENT.match(/data-close-appeal-dialog/g)).toHaveLength(2);
    expect(dialog).toContain('data-testid="close-appeal-submit" disabled class="btn btn-gold"');
  });

  it('says the comment is public and closing is final', () => {
    const dialog = dialogOf('decide-appeal-dialog');
    expect(dialog).toContain('Appeal result (shown publicly on this incident)');
    expect(dialog).toMatch(/Closing is final and cannot be undone\./);
    expect(dialog).toContain('aria-describedby="close-appeal-counter close-appeal-final"');
  });

  it('keeps each live counter outside its label and links it to the textarea', () => {
    for (const [attr, counter] of [
      ['decide-appeal-dialog', 'close-appeal-counter'],
      ['appeal-comment-dialog', 'appeal-comment-counter'],
    ]) {
      const dialog = dialogOf(attr);
      expect(dialog).toContain(`<span id="${counter}"`);
      expect(dialog).toMatch(new RegExp(`aria-describedby="${counter}`));
      const textareaLabelEnd = dialog.indexOf('</label>', dialog.indexOf('<textarea'));
      const labelStart = dialog.lastIndexOf('<label', dialog.indexOf('<textarea'));
      expect(dialog.slice(labelStart, textareaLabelEnd)).not.toContain('aria-live');
      expect(dialog.indexOf(`<span id="${counter}"`)).toBeGreaterThan(textareaLabelEnd);
    }
  });

  it('has an Add/Edit Comment popup with a required comment and a counter', () => {
    const dialog = dialogOf('appeal-comment-dialog');
    expect(dialog).toContain('data-testid="appeal-comment-dialog"');
    expect(dialog).toContain('<input type="hidden" name="intent" value="save-appeal-comment" />');
    expect(dialog).toMatch(/name="body"[\s\S]*?required[\s\S]*?maxlength=\{APPEAL_COMMENT_MAX_LENGTH\}/);
    expect(dialog).toContain('data-appeal-comment-counter');
  });

  it('loads its script from the shell page', () => {
    expect(SHELL).toContain("import '../../../scripts/appealDialogs';");
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
