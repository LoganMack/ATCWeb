/**
 * Admin page guards for Staff (broadcaster-staff-roles, BR2.3, BR2.7, Q2): the restricted areas' pages check
 * for a full Admin, Admin > Users re-checks it before any change, the dashboard leaves the restricted tools out
 * for Staff, and the Circuits import is gone. The database enforces the same rules
 * (supabase/checks/staff-broadcaster-fixtures.sql); these keep the pages from offering what it would refuse.
 */
import { describe, expect, it } from 'vitest';
import { adminToolsFor, isStaffRestrictedPath } from '../../src/lib/auth';
import { getImportTemplateCsv } from '../../src/lib/importTemplates';

const PAGES = import.meta.glob('/src/pages/admin/**/*.astro', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const RESTRICTED_FOLDERS = ['site-properties', 'champions', 'seasons', 'rulesets', 'media', 'circuits'];
const restrictedPages = Object.keys(PAGES).filter((path) =>
  RESTRICTED_FOLDERS.some((folder) => path.startsWith(`/src/pages/admin/${folder}/`)),
);
const sharedPages = Object.keys(PAGES).filter(
  (path) => !restrictedPages.includes(path) && /requireAdmin|requireFullAdmin/.test(PAGES[path]),
);

describe('restricted admin pages', () => {
  it('finds a page in every restricted folder, including the champions sub-pages', () => {
    for (const folder of RESTRICTED_FOLDERS) {
      expect(
        restrictedPages.some((p) => p.startsWith(`/src/pages/admin/${folder}/`)),
        folder,
      ).toBe(true);
    }
    expect(restrictedPages).toContain('/src/pages/admin/champions/[seasonId]/[classId].astro');
    expect(restrictedPages).toContain('/src/pages/admin/champions/hall-of-fame/[driverId].astro');
  });

  it.each(restrictedPages)('%s checks for a full Admin, never just panel access', (path) => {
    const source = PAGES[path];
    expect(source).toMatch(
      /const admin = requireFullAdmin\(Astro\);\s*if \(admin instanceof Response\) return admin;/,
    );
    expect(source).not.toMatch(/\brequireAdmin\(/);
    expect(
      isStaffRestrictedPath(path.replace('/src/pages', '').replace(/\/index\.astro$|\.astro$/, '')),
    ).toBe(true);
  });

  it('leaves the shared pages on panel access, so Staff can use them', () => {
    expect(sharedPages).toContain('/src/pages/admin/signups/index.astro');
    expect(sharedPages).toContain('/src/pages/admin/users/index.astro');
    for (const path of sharedPages) expect(PAGES[path], path).not.toMatch(/\brequireFullAdmin\(/);
  });
});

describe('Admin > Users for Staff', () => {
  const users = PAGES['/src/pages/admin/users/index.astro'];
  const post = users.slice(users.indexOf("Astro.request.method === 'POST'"));

  it('re-checks full Admin before any posted change', () => {
    expect(users).toContain('const canEdit = isFullAdmin(admin.profile);');
    const guard = post.indexOf('if (!canEdit) {');
    expect(guard).toBeGreaterThan(-1);
    for (const action of ['deleteUser(', 'setProfileDriver(', 'setProfileRole(', 'setBroadcaster(']) {
      expect(post.indexOf(action), action).toBeGreaterThan(guard);
    }
  });

  it('logs every change it makes', () => {
    expect(post.match(/await logActivity\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(post).toContain('details: `Broadcaster set to ${targetName}`');
    expect(post).toContain("details: 'Broadcaster removed'");
  });

  it('shows Staff text instead of forms, and offers the Staff role and Broadcaster to an Admin', () => {
    expect(users).toContain('Staff can view accounts but not change them.');
    expect(users).toMatch(/const ROLES: ProfileRole\[\] = \['driver', 'staff', 'admin'\];/);
    expect(users).toMatch(/\{canEdit \? \(\s*\/\*[\s\S]*?\*\/\s*<form/);
    expect(users).toContain('value={BROADCASTER_OPTION}');
  });
});

describe('dashboard tools by role', () => {
  const tools = [
    { href: '/admin/import', label: 'Add Race Result' },
    { href: '/admin/news', label: 'News' },
    { href: '/admin/circuits', label: 'Circuits' },
    { href: '/admin/media', label: 'Media' },
    { href: '/admin/rulesets', label: 'Rulesets' },
    { href: '/admin/seasons', label: 'Seasons' },
    { href: '/admin/site-properties', label: 'Site Properties' },
  ];

  it('gives a full Admin every tool', () => {
    expect(adminToolsFor(tools, { role: 'admin' })).toEqual(tools);
  });

  it('leaves the five restricted areas out for Staff', () => {
    expect(adminToolsFor(tools, { role: 'staff' }).map((t) => t.label)).toEqual(['Add Race Result', 'News']);
  });

  it('is what the dashboard renders', () => {
    const dashboard = PAGES['/src/pages/admin/fragment.astro'];
    expect(dashboard).toContain('const tools = adminToolsFor(allTools, admin.profile);');
    expect(dashboard).not.toContain('Current season:');
  });
});

describe('Import Tools without the Circuits import (Q2)', () => {
  it('has no circuits template or importer', () => {
    expect(getImportTemplateCsv('circuits')).toBeNull();
    expect(getImportTemplateCsv('events')).not.toBeNull();
    expect(getImportTemplateCsv('news')).not.toBeNull();
    const page = PAGES['/src/pages/admin/import-tools/index.astro'];
    expect(page).not.toContain('import-circuits');
    expect(page).not.toMatch(/kind: 'circuits'/);
  });
});
