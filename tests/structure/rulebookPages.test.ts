/**
 * The rulebook pages (native rulebook): the admin editor checks the admin role itself and writes only through
 * src/lib (FR1.4, FR4.1); the editor's script is loaded by that page alone; the public page reads through
 * src/lib, is edge-cacheable and keeps the rendered HTML to the shared renderer (NFR1, NFR2); and the nav's
 * Rulebook link points at /rulebook on the site (FR6.1).
 */
import { describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SRC = raw(import.meta.glob('/src/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }));

const ADMIN = SRC['/src/pages/admin/rulebook.astro'];
const PUBLIC = SRC['/src/pages/rulebook.astro'];
const NAV = SRC['/src/components/Nav.astro'];

/** The frontmatter between the first two `---` lines. */
const frontmatter = (text: string) => text.split(/^---$/m)[1] ?? '';

describe('the admin rulebook editor (FR1.4, FR4.1)', () => {
  it('runs the admin check before anything else and returns its redirect', () => {
    const fm = frontmatter(ADMIN);
    expect(fm).toMatch(
      /const admin = requireAdmin\(Astro\);\s*if \(admin instanceof Response\) return admin;/,
    );
    expect(fm.indexOf('requireAdmin(Astro)')).toBeLessThan(fm.indexOf('formData()'));
  });

  it('never calls Supabase directly: no client library, no REST paths, no fetch', () => {
    expect(ADMIN).not.toMatch(/@supabase\/|rest\/v1|\bfetch\(/);
    expect(ADMIN).toMatch(/from '\.\.\/\.\.\/lib\/db\/rulebook'/);
  });

  it('reads the form once, posts a hidden intent and the version it started from', () => {
    expect(ADMIN.match(/formData\(\)/g)).toHaveLength(1);
    expect(ADMIN).toMatch(/name="intent" value="save"/);
    expect(ADMIN).toMatch(/name="intent" value="restore"/);
    expect(ADMIN).toMatch(/name="expected_latest_id"/);
    for (const button of ADMIN.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/class="btn btn-/);
  });

  it('is linked from the admin bar and the dashboard tools', () => {
    expect(SRC['/src/layouts/AdminLayout.astro']).toContain("{ href: '/admin/rulebook', label: 'Rulebook' }");
    const dashboard = SRC['/src/pages/admin/fragment.astro'];
    expect(dashboard).toMatch(/\{ href: '\/admin\/rulebook', label: 'Rulebook'/);
    expect(dashboard).toMatch(/\n {2}Rulebook: \['/);
  });

  it('loads the live preview script from this page only', () => {
    const importers = Object.keys(SRC).filter((f) =>
      /import ['"](?:\.\.\/)+scripts\/rulebookEditor['"]/.test(SRC[f]),
    );
    expect(importers).toEqual(['/src/pages/admin/rulebook.astro']);
    expect(SRC['/src/scripts/rulebookEditor.ts']).toMatch(/from '\.\.\/lib\/rulebookMarkdown'/);
  });
});

describe('the public rulebook page (FR2, NFR1, NFR2)', () => {
  it('reads the latest version through src/lib and renders it with the shared renderer', () => {
    expect(PUBLIC).not.toMatch(/@supabase\/|rest\/v1|\bfetch\(/);
    expect(PUBLIC).toMatch(/\bgetLatestRulebook\(/);
    expect(PUBLIC).toMatch(/\brenderRulebookVersion\(/);
    // The only HTML injected is the renderer's output.
    expect(PUBLIC.match(/set:html=\{([^}]+)\}/g)).toEqual(['set:html={rendered.html}']);
  });

  it('sends the shared public cache header and marks a failed load uncacheable', () => {
    expect(PUBLIC).toContain(
      "Astro.response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');",
    );
    expect(PUBLIC).toMatch(/markUncacheable\(Astro\)/);
  });

  it('labels the contents panel as a navigation landmark', () => {
    expect(PUBLIC).toMatch(/<nav[^>]*aria-label="Rulebook contents"/);
    expect(PUBLIC).toContain('The rulebook has not been published yet.');
    // The panel (FR3.3, FR3.5): headings, then the fixed Tables section, or "No tables".
    const contents = SRC['/src/components/RulebookContents.astro'];
    expect(contents.indexOf('>Tables</p>')).toBeGreaterThan(contents.indexOf('headings.map'));
    expect(contents).toContain('>No tables</p>');
    expect(PUBLIC.match(/<RulebookContents\b/g)).toHaveLength(2);
    expect(PUBLIC).toMatch(/<details[^>]*lg:hidden[\s\S]*?<summary[^>]*>Contents<\/summary>/);
  });
});

describe('the nav (FR6.1)', () => {
  it('links Rulebook to /rulebook on the site, not to the Google Doc', () => {
    expect(NAV).toContain("{ href: '/rulebook', label: 'Rulebook' }");
    expect(NAV).not.toMatch(/docs\.google\.com|RULEBOOK_URL/);
    expect(NAV).not.toMatch(/label: 'Rulebook', external/);
  });
});
