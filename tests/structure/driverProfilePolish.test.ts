/**
 * driver-profile-polish, one check per requirement that lives in markup or CSS (FR1-FR4, FR6-FR10), read
 * from the sources as text like the other structure tests. Behaviour that needs data is covered in tests/lib.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const ASTRO = raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }));

function source(path: string): string {
  const text = ASTRO[path];
  if (text === undefined) throw new Error(`${path} is missing`);
  return text;
}

/** Markup without HTML and JS comments, so prose never satisfies a check. */
function code(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// Vitest empties .css imports, so the stylesheet is read from disk (as in frontEnd.test.ts).
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const NAV = '/src/components/Nav.astro';
const SHELL = '/src/pages/drivers/[id].astro';
const FRAGMENT = '/src/pages/drivers/[id]/fragment.astro';

describe('FR1: nav dropdown options are upright', () => {
  it('resets italics on the desktop dropdown panel, which also holds the rounds list', () => {
    const nav = code(source(NAV));
    const panel = nav.match(/<div class="min-w-\[11rem\][^"]*"/)?.[0] ?? '';
    expect(panel).toContain('not-italic');
    expect(nav.indexOf('<div data-nav-rounds class')).toBeGreaterThan(nav.indexOf(panel));
  });
});

describe('FR2: profile header icons', () => {
  const shell = code(source(SHELL));
  const header = shell.slice(shell.indexOf('data-testid="driver-header-name-row"'), shell.indexOf('<h1'));

  it('puts the class symbol, flag(s) and team logo before the name, each named and focusable', () => {
    expect(header).toMatch(/data-testid="driver-class-icon"/);
    expect(header).toMatch(/role="img"\s+aria-label=\{className\}\s+title=\{className\}\s+tabindex="0"/);
    expect(header).toMatch(/<DriverFlag[\s\S]*?\blabelled\b/);
    expect(header).toMatch(/<TeamLogo[^>]*\blabelled\b/);
    expect(header.indexOf('driver-class-icon')).toBeLessThan(header.indexOf('<DriverFlag'));
    expect(header.indexOf('<DriverFlag')).toBeLessThan(header.indexOf('<TeamLogo'));
  });

  it('drops the country names, team name and "Independent" text', () => {
    expect(shell).not.toContain('showLabel');
    expect(shell).not.toContain("'Independent'");
    expect(shell).not.toMatch(/driver\.teams\?\.name \?\?/);
  });

  it('gives the flag and logo icons role="img", an aria-label, a title and focus', () => {
    const flag = code(source('/src/components/DriverFlag.astro'));
    expect(flag).toMatch(/role="img"\s+aria-label=\{label\}\s+title=\{label\}\s+tabindex="0"/);
    const logo = code(source('/src/components/TeamLogo.astro'));
    expect(
      logo.match(/role="img"\s+aria-label=\{hoverText\}\s+title=\{hoverText\}\s+tabindex="0"/g),
    ).toHaveLength(2);
    // The name also shows on keyboard focus, where a title never appears.
    expect(code(source('/src/components/IconTip.astro'))).toContain('group-focus-within:opacity-100');
  });
});

describe('FR3 and FR4: profile Races and Incidents tables', () => {
  const fragment = code(source(FRAGMENT));
  const races = fragment.slice(
    fragment.indexOf('data-driver-panel="races"'),
    fragment.indexOf('data-driver-panel="splits"'),
  );
  const incidents = fragment.slice(fragment.indexOf('data-driver-panel="incidents"'));

  it('shows no date under the Races round link (FR3)', () => {
    expect(races).toContain('data-col="round"');
    expect(races).not.toMatch(/formatDateShort\(r\.startTime/);
  });

  it('puts a sortable Date column before Round, and labels the round "ATCX, Round X" (FR4)', () => {
    expect(incidents.indexOf('data-sort-key="date"')).toBeGreaterThan(-1);
    expect(incidents.indexOf('data-sort-key="date"')).toBeLessThan(
      incidents.indexOf('data-sort-key="round"'),
    );
    expect(incidents).toMatch(/data-col="date" data-sort-value=\{row\.startTime\}/);
    expect(incidents).toContain('seasonRoundLabel(row.seasonLabel, row.displayRoundNumber)');
    const roundCell = incidents.slice(
      incidents.indexOf('data-col="round"'),
      incidents.indexOf('data-col="penalized"'),
    );
    expect(roundCell).not.toContain('formatDateShort');
  });
});

describe('FR6: profile kudos button and dialog', () => {
  const kudos = code(source('/src/pages/drivers/[id]/kudos.astro'));

  it('renders nothing for no kudos or a private profile, and names the button by its count', () => {
    expect(kudos).toContain('{!privateProfile && !loadError && count > 0 && (');
    expect(kudos).toMatch(/aria-haspopup="dialog"\s+aria-label=\{label\}/);
    expect(kudos).toContain('const label = `${count} kudos`;');
  });

  it('lists the entries with the shared card and closes from its own button', () => {
    expect(kudos).toMatch(/<dialog[\s\S]*data-driver-kudos-dialog/);
    expect(kudos).toContain('<KudosEntryCard entry={entry}');
    expect(kudos).toContain('data-close-driver-kudos');
  });

  it('imports the dialog script from the profile page only', () => {
    const importers = Object.keys(ASTRO).filter((f) => /scripts\/driverKudos['"]/.test(ASTRO[f]));
    expect(importers).toEqual([SHELL]);
  });
});

describe('FR7 and FR8: History > Kudos and Interviews', () => {
  it('lists both in the History menu, the mobile menu and the section picker', () => {
    const nav = code(source(NAV));
    expect(nav).toContain("{ href: '/kudos', label: 'Kudos', mobile: true }");
    expect(nav).toContain("{ href: '/interviews', label: 'Interviews', mobile: true }");
    expect(nav).toContain('link.menu?.filter((item) => item.mobile)');
    const tabs = code(source('/src/components/HistoryTabs.astro'));
    expect(tabs).toContain("{ key: 'kudos', href: '/kudos', label: 'Kudos' }");
    expect(tabs).toContain("{ key: 'interviews', href: '/interviews', label: 'Interviews' }");
  });

  it('shows an empty state for a season with nothing to list', () => {
    expect(code(source('/src/pages/kudos/fragment.astro'))).toContain('data-testid="kudos-empty"');
    expect(code(source('/src/pages/interviews/fragment.astro'))).toContain('data-testid="interviews-empty"');
  });

  it('reads nothing for a signed-out visitor and offers a sign-in link instead (FR8.2)', () => {
    const fragment = code(source('/src/pages/interviews/fragment.astro'));
    const reads = fragment.slice(fragment.indexOf('if (session) {'), fragment.indexOf('const signInHref'));
    expect(reads).toContain('getSeasons(');
    expect(reads).toContain('getMemberInterviews(supabaseEnv, session.accessToken');
    expect(fragment.slice(0, fragment.indexOf('if (session) {'))).not.toMatch(/await /);
    expect(fragment).toMatch(/\{!session && \([\s\S]*href=\{signInHref\}/);
    expect(fragment).toContain("Astro.response.headers.set('Cache-Control', 'private, no-store');");
  });

  it('loads no audio until play (FR8.4)', () => {
    const fragment = code(source('/src/pages/interviews/fragment.astro'));
    expect(fragment).toMatch(
      /<audio\s+controls\s+preload="none"\s+src=\{`\/api\/interviews\/\$\{i\.id\}\/audio`\}/,
    );
  });
});

describe('FR9: driver-name links', () => {
  it('underlines a driver link only on hover or focus, keeping its colour', () => {
    expect(GLOBAL_CSS).toMatch(
      /a\.driver-link:hover,\s*a\.driver-link:focus-visible,[^{]*\{\s*text-decoration: underline;/,
    );
    expect(GLOBAL_CSS).toMatch(/a\.driver-link \{\s*color: inherit;[\s\S]*?text-decoration: none;/);
    expect(code(source('/src/components/DriverRow.astro'))).toContain('class="driver-row-name');
  });

  it('keeps a row still while a driver link inside it is pressed', () => {
    expect(GLOBAL_CSS).toContain("[role='button']:not(.cm-pin):not(:has(a.driver-link:active)):active {");
    expect(GLOBAL_CSS).not.toMatch(/\[role='button'\]:not\(\.cm-pin\):active/);
  });
});

describe('FR10: admin panel', () => {
  const layout = code(source('/src/layouts/AdminLayout.astro'));
  const dashboard = code(source('/src/pages/admin/fragment.astro'));

  it('has no tab row, keeps the name and Log Out, and links back to the dashboard off /admin', () => {
    expect(layout).not.toMatch(/<nav\b/);
    expect(layout).not.toContain('const links');
    expect(layout).toContain('userDisplayName(session?.profile, session?.user.email)');
    expect(layout).toMatch(/action="\/api\/logout"[\s\S]*Log Out/);
    expect(layout).toMatch(/\{!onDashboard && \(\s*<a\s+href="\/admin"/);
    expect(layout).toContain('← Back to dashboard');
  });

  it('puts Email below Site Analytics and drops the Import Tools tool', () => {
    expect(dashboard.indexOf('data-email-counts>')).toBeGreaterThan(
      dashboard.indexOf('>Site Analytics</h2>'),
    );
    expect(dashboard).not.toContain("label: 'Import Tools'");
    expect(dashboard).not.toContain("'Import Tools':");
  });
});
