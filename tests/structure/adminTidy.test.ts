/**
 * The incident pages and admin panel tidy-up (nav-admin-polish FR1-FR5): the round incident page's one back
 * link and Review Submissions view, the Incident Reporting columns, the Users filter card, the dashboard's
 * buttons, latest-event card and Email section, and the All Incidents table's columns.
 */
import { describe, expect, it } from 'vitest';

// Line endings normalised, so a Windows checkout reads the same as CI.
const SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);

const SHELL = SRC['/src/pages/results/[subsessionId]/incidents.astro'];
const FRAGMENT = SRC['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const REPORTING = SRC['/src/pages/admin/incident-reporting/index.astro'];
const USERS = SRC['/src/pages/admin/users/index.astro'];
const DASHBOARD = SRC['/src/pages/admin/fragment.astro'];
const ALL_TABLE = SRC['/src/components/IncidentsAllTable.astro'];

describe('the round incident page (FR2)', () => {
  it('shows one back link, chosen by incidentBackLink from the page address (BR2.3)', () => {
    expect(SHELL).toContain(
      "const backLink = incidentBackLink(parseIncidentOrigin(Astro.url.searchParams.get('from')), backToRoundHref);",
    );
    expect(SHELL.match(/data-testid="incident-page-back-link"/g)).toHaveLength(1);
    expect(SHELL).toContain('href={backLink.href} class="text-sm text-white/50 hover:text-white"');
    expect(SHELL).not.toContain('&larr; Incident Reporting');
    expect(SHELL).not.toContain('&larr; Back to Results');
  });

  it('lists appeals only in Review Submissions, under the button label "Review Submissions" (BR2.1, BR2.2)', () => {
    expect(FRAGMENT).not.toContain('Submitted Appeals');
    expect(FRAGMENT).toContain('if (adminSession && viewReports) {');
    expect(FRAGMENT).toContain(
      'const showIncidentList = viewReports && (incidentReports.length > 0 || incidentAppeals.length > 0);',
    );
    expect(FRAGMENT).toContain("`Review Submissions${openReportCount > 0 ? ` (${openReportCount})` : ''}`");
    expect(FRAGMENT).not.toContain('View Reported Incidents');
    // The links between the two views keep the origin marker (BR2.4).
    expect(FRAGMENT.match(/withIncidentOrigin\(/g)).toHaveLength(2);
  });
});

describe('Admin > Incident Reporting (FR3)', () => {
  it('reads Round, Logo, the counts, Post Date, links and then Posted, with the logo from lg (BR3.2-BR3.4)', () => {
    const head = REPORTING.slice(REPORTING.indexOf('<thead'), REPORTING.indexOf('</thead>'));
    const headers = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').trim(),
    );
    expect(headers).toEqual([
      'Round',
      'Logo',
      'Reported',
      'Pending',
      'Dismissed',
      'Logged',
      'Post Date',
      '',
      'Posted',
    ]);
    expect(head).toMatch(
      /<th class="hidden px-3 py-3 font-semibold lg:table-cell"><span class="sr-only">Logo/,
    );
    expect(REPORTING).toContain(
      '<td class="hidden px-3 py-2 lg:table-cell" data-testid="incident-reporting-logo">',
    );
    expect(REPORTING).toContain('alt={r.trackName}');
    expect(REPORTING).toContain('colspan="9"');
    expect(REPORTING).not.toContain(': {r.trackName}');
    // The Posted switch's form is the last cell in the row.
    const row = REPORTING.slice(
      REPORTING.indexOf('{visibleRows.map('),
      REPORTING.indexOf('{visibleRows.length === 0'),
    );
    expect(row.lastIndexOf('data-post-switch')).toBeGreaterThan(
      row.lastIndexOf('incident-reporting-report-link'),
    );
  });

  it('opens the round incident page with from=reporting from both links (BR2.7)', () => {
    expect(REPORTING).toContain(
      'href={withIncidentOrigin(`/results/${r.subsessionId}/incidents?view=reports`, REPORTING_ORIGIN)}',
    );
    expect(REPORTING).toContain(
      'href={withIncidentOrigin(`/results/${r.subsessionId}/incidents`, REPORTING_ORIGIN)}',
    );
  });
});

describe('Admin > Users (FR4)', () => {
  it('has a filter card with a labelled search and a labelled Role dropdown, and no privacy note (BR4.4-BR4.6)', () => {
    expect(USERS).toMatch(/<span[^>]*>Search<\/span>\s*<input\s+type="search"/);
    expect(USERS).toMatch(/<input\s+type="search"[^>]*class="search-input /);
    expect(USERS).toMatch(/<span[^>]*>Role<\/span>\s*<select/);
    const options = [
      ...USERS.matchAll(/<option value="(\w*)" class="bg-brand-ink text-white">(\w+)<\/option>/g),
    ].map((m) => `${m[1]}:${m[2]}`);
    expect(options).toEqual([':All', 'admin:Admin', 'staff:Staff', 'driver:Driver']);
    expect(USERS).toContain('data-role={profile.role}');
    expect(USERS).toContain("data-search={`${label} ${emailById.get(profile.id) ?? ''}`.toLowerCase()}");
    expect(USERS).toContain('No matches.');
    expect(USERS).not.toContain('users-driver-privacy-note');
  });

  it('sorts by the shown name ignoring case, then email, and combines the two filters (BR4.3, BR4.5)', () => {
    expect(USERS).toContain("nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })");
    expect(USERS).toContain('{sortedProfiles.map((profile) => {');
    expect(USERS).toMatch(
      /\(!term \|\| \(row\.dataset\.search \?\? ''\)\.includes\(term\)\) && \(!role\.value \|\| row\.dataset\.role === role\.value\)/,
    );
  });
});

describe('Admin dashboard (FR5)', () => {
  it('shows icon-and-title buttons, with Incident Reports moved to Admin Tools (BR5.1, BR5.2)', () => {
    expect(DASHBOARD).not.toContain('{card.detail}</p>');
    expect(DASHBOARD).not.toMatch(
      /pendingSignupCount|openIncidentReportCount|activityLogCount24h|getDrivers|getTeams\b/,
    );
    const tools = DASHBOARD.slice(DASHBOARD.indexOf('const allTools'), DASHBOARD.indexOf('const tools ='));
    expect(tools).toContain("{ href: '/admin/incident-reporting', label: 'Incident Reports'");
    const buttons = DASHBOARD.slice(
      DASHBOARD.indexOf('const notifications'),
      DASHBOARD.indexOf('const allTools'),
    );
    expect(buttons).not.toContain('incident-reporting');
  });

  it('has the latest-event card with its Review Submissions button and both fallback states (BR5.10, BR5.11)', () => {
    expect(DASHBOARD).toContain('{ userId: admin.user.id, driverId: admin.profile?.driver_id ?? null }');
    expect(DASHBOARD).toContain('data-testid="latest-event-card"');
    expect(DASHBOARD).toMatch(
      /href=\{`\/results\/\$\{latestEvent\.summary\.subsessionId\}\/incidents\?view=reports`\}\s*class="btn btn-primary btn-sm/,
    );
    expect(DASHBOARD).toContain(
      "{latestEvent.state === 'none' ? 'No events yet' : 'Latest event unavailable'}",
    );
  });

  it('collapses Email Templates, opens it after a save or reset, and keeps its anchor (BR5.12, BR5.13)', () => {
    expect(DASHBOARD).toMatch(
      /<details id=\{EMAIL_TEMPLATES_ANCHOR\}[^>]*open=\{emailFlash \? true : undefined\}/,
    );
    expect(DASHBOARD).toContain('<h3>Email Templates</h3>');
    expect(DASHBOARD).not.toContain('Email wording');
    expect(DASHBOARD).not.toContain('Leave a field empty, or use Reset');
    const stats = DASHBOARD.slice(
      DASHBOARD.indexOf('const emailStats'),
      DASHBOARD.indexOf('interface DashboardButton'),
    );
    expect([...stats.matchAll(/label: '([^']+)'/g)].map((m) => m[1])).toEqual([
      'Emails queued',
      'Dropped in the last 7 days',
      'Delivery unknown in the last 7 days',
      'Enqueue failures in the last 7 days',
      'Sent in the last 7 days',
    ]);
    expect(DASHBOARD).toContain("value: emailCounts.sent7d === null ? '—' : String(emailCounts.sent7d)");
  });
});

describe('the All Incidents table (FR1)', () => {
  it('has an "At Fault" column and no Date column (BR1.1, BR1.2)', () => {
    expect(ALL_TABLE).toMatch(/data-sort-key="driver">At Fault<\/th>/);
    expect(ALL_TABLE).not.toMatch(/data-sort-key="date"|>Date<\/th>|formatDateShort/);
  });
});
