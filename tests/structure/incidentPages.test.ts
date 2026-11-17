import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Line endings normalised, so a Windows checkout reads the same as CI.
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const FRAGMENT = read('src/pages/results/[subsessionId]/incidents/fragment.astro');
const SHELL = read('src/pages/results/[subsessionId]/incidents.astro');
const REPORTING = read('src/pages/admin/incident-reporting/index.astro');
const ATTACHMENTS = read('src/scripts/appealAttachments.ts');
const MANAGEMENT = read('src/scripts/incidentManagement.ts');
const MANAGEMENT_DIALOGS = read('src/components/IncidentManagementDialogs.astro');
const MEDIA = read('src/components/IncidentCardMedia.astro');

/** The markup after the frontmatter. */
const MARKUP = FRAGMENT.slice(FRAGMENT.indexOf('\n---', 4));

describe('Incident Report header (US1.1, US3.1)', () => {
  it('has no unposted notice', () => {
    expect(FRAGMENT).not.toContain("This incident report isn't posted yet");
  });

  it('titles the two screens without the track name', () => {
    expect(MARKUP).toContain("{viewReports ? 'Reported Incidents' : 'Incident Report'}\n        </h1>");
    // The browser tab keeps the track name.
    expect(MARKUP).toContain("data-page-title={`${viewReports ? 'Reported Incidents' : 'Incident Report'}: ${round.track_name}`}");
  });

  it('builds the subtitle from incidentSubtitle with the season round number', () => {
    expect(FRAGMENT).toContain('incidentSubtitle(round.start_time, round.season_label, displayRoundNumber)');
    expect(MARKUP).toMatch(/data-testid="incident-subtitle">\s*\{subtitle\}/);
  });

  it('reads the season rounds once, shared by the PP context and the subtitle', () => {
    expect(FRAGMENT.split('getRoundsForSeason(').length - 1).toBe(1);
    expect(FRAGMENT).toContain('round?.season_id ? getRoundsForSeason(supabaseEnv, round.season_id) : null');
    expect(FRAGMENT).toContain('seasonRoundsPromise?.catch(() => {});');
  });
});

describe('Post Report (US2.2)', () => {
  it('shows only to admins and staff on the Incident Report of an unposted round', () => {
    expect(FRAGMENT).toContain('const showPostReport = isAdmin && !roundPosted && !viewReports;');
    expect(MARKUP).toContain('{showPostReport && (\n              postState ===');
  });

  it('reads the reporting window only when the button shows', () => {
    expect(FRAGMENT).toMatch(/showPostReport && roundForReads\s*\?\s*getReportingPeriodHours\(supabaseEnv\)/);
    expect(FRAGMENT.split('getReportingWindowForRound(').length - 1).toBe(1);
  });

  it('is aria-disabled with its tip while submissions are open', () => {
    const disabled = MARKUP.slice(MARKUP.indexOf("postState === 'disabled'"), MARKUP.indexOf('</IconTip>'));
    expect(disabled).toContain('<IconTip label="Incident submissions still open.">');
    expect(disabled).toContain('aria-disabled="true"');
    expect(disabled).toContain('title="Incident submissions still open."');
    expect(disabled).not.toMatch(/\sdisabled[\s>]/);
    // Screen readers get the reason, since the tip is aria-hidden.
    expect(disabled).toContain('aria-describedby="post-report-disabled-reason"');
    expect(MARKUP).toContain('<span id="post-report-disabled-reason" class="sr-only">Incident submissions still open.</span>');
  });

  it('confirms with a Warning popup that posts intent=post-report', () => {
    const dialog = MARKUP.slice(MARKUP.indexOf('data-post-report-dialog'), MARKUP.indexOf('</dialog>', MARKUP.indexOf('data-post-report-dialog')));
    expect(dialog).toContain('>Warning</h4>');
    expect(dialog).toContain('This will send website and email notifications to all drivers from this round.');
    expect(dialog).toContain('<input type="hidden" name="intent" value="post-report" />');
    expect(dialog.indexOf('data-close-post-report-dialog')).toBeLessThan(dialog.indexOf('type="submit"'));
    // The popup ignores clicks while the button is aria-disabled.
    expect(SHELL).toContain("if (trigger.getAttribute('aria-disabled') === 'true') return;");
  });

  it('dispatches post-report as an admin-only intent', () => {
    expect(FRAGMENT).toContain("['post-report', handlePostReport],");
    const submitAppeal = FRAGMENT.indexOf("=== 'submit-appeal') return toResponse");
    const adminBlock = FRAGMENT.indexOf('if (adminSession && postForm) {');
    expect(submitAppeal).toBeGreaterThan(0);
    expect(adminBlock).toBeGreaterThan(submitAppeal);
    expect(FRAGMENT.indexOf('ADMIN_HANDLERS.get(intent)')).toBeGreaterThan(adminBlock);
  });

  it('shows the failure banner only to admins', () => {
    expect(FRAGMENT).toContain("const postParam = isAdmin ? Astro.url.searchParams.get('post') : null;");
    expect(FRAGMENT).toContain("Couldn't post the report. Try again.");
    expect(FRAGMENT).toContain("Incident submissions are still open, so the report wasn't posted.");
  });
});

describe('Reported Incidents buttons (US2.1)', () => {
  it('moves Add Incident and Add Round Penalty off the Incident Report header', () => {
    const header = MARKUP.slice(MARKUP.indexOf('incident-view-toggle"'), MARKUP.indexOf('{appealFlash && ('));
    expect(header).not.toContain('data-open-incident-dialog');
    expect(header).not.toContain('data-add-round-penalty');
  });

  it('puts them at the right of the filter row and above the empty message', () => {
    const groups = MARKUP.split('data-reported-actions').slice(1);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.slice(0, 800)).toContain('data-open-incident-dialog');
      expect(g.slice(0, 800)).toContain('{roundPenaltyData.available && (');
    }
    expect(MARKUP).toContain('<div class="flex flex-wrap items-center gap-2 lg:ml-auto" data-reported-actions>');
    expect(MARKUP).toMatch(/\{viewReports && !showIncidentList && \(\s*<>[\s\S]*data-reported-actions[\s\S]*No submitted incidents for this round\./);
  });

  it('renders the round penalty popup on both screens', () => {
    expect(MARKUP).toContain('{roundPenaltyData.available && isAdmin && (\n          <div id={viewReports ? undefined : ROUND_PENALTIES_ANCHOR}>');
    expect(MARKUP).not.toContain('{!viewReports && roundPenaltyData.available && isAdmin && (');
  });
});

describe('Penalty Summary (US3.2)', () => {
  it('is renamed with a divider above it', () => {
    expect(FRAGMENT).not.toContain('Round Summary');
    expect(MARKUP).toContain('class="mt-12 scroll-mt-24 border-t border-white/10 pt-8" data-testid="penalty-summary"');
    expect(MARKUP).toContain('>Penalty Summary</h3>');
  });
});

describe('Appeal card media (US4.1)', () => {
  it('uses the shared media block on report and appeal cards', () => {
    expect(MARKUP.split('<IncidentCardMedia').length - 1).toBe(2);
    expect(MARKUP).toContain('class="hidden lg:flex"');
    expect(MARKUP).toContain('testId="appeal-card-media"');
  });

  it('shows the appeal map only when the turn matches a corner', () => {
    expect(FRAGMENT).toContain('const appealMapUrl = appealCorners.length > 0 ? reportMapUrl : null;');
  });

  it('renders nothing without a clip or a map', () => {
    expect(MEDIA).toContain('{(videoUrl || mapUrl) && (');
  });
});

describe('Admin Incident Reporting list (US2.3)', () => {
  it('has no Posted column, toggle or re-post popup', () => {
    expect(REPORTING).not.toContain('set-posted');
    expect(REPORTING).not.toContain('repostDialog');
    expect(REPORTING).not.toContain('data-repost-dialog');
    expect(REPORTING).not.toMatch(/<th[^>]*>Posted<\/th>/);
  });
});

describe('Appeal attachments (US5.1)', () => {
  it('builds rows without HTML strings', () => {
    expect(ATTACHMENTS).not.toContain('innerHTML');
    expect(ATTACHMENTS).not.toContain('insertAdjacentHTML');
  });

  it('is wired into both appeal popups', () => {
    expect(SHELL).toContain('attachAppealFiles({');
    expect(SHELL).toContain("list: appealDialog.querySelector<HTMLElement>('[data-appeal-file-list]')!");
    expect(SHELL).toContain('attachments.reset();');
    expect(MANAGEMENT).toContain('attachAppealFiles({');
    expect(MANAGEMENT).toContain('appealAttachmentsFor(dialog, form)?.reset();');
    expect(MARKUP).toContain('<ul data-appeal-file-list');
    expect(MANAGEMENT_DIALOGS).toContain('<ul data-incident-appeal-file-list');
  });

  it('announces refusals on the incident page', () => {
    expect(MARKUP).toContain('<p data-appeal-error aria-live="polite"');
  });

  it('keeps the submit-time check as a backstop and drops the change-time one', () => {
    expect(SHELL).toContain("appealForm.addEventListener('submit'");
    expect(SHELL).not.toContain("fileInput.addEventListener('change'");
  });
});
