/**
 * The admin header rule (broadcaster-staff-roles BR3.1, FR3.1-FR3.4): AdminLayout renders the one page title,
 * on the line with the account name and Log Out, with "← Back to Dashboard" above it off the dashboard and the
 * public pages' top spacing. No /admin page renders its own title or a subtitle under it.
 */
import { describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const LAYOUT = raw(
  import.meta.glob('/src/layouts/AdminLayout.astro', { query: '?raw', import: 'default', eager: true }),
)['/src/layouts/AdminLayout.astro'];
const PAGES = raw(
  import.meta.glob('/src/pages/admin/**/*.astro', { query: '?raw', import: 'default', eager: true }),
);
// Pages that render the layout; fragments are bare HTML for a shell and render none.
const LAYOUT_PAGES = Object.entries(PAGES).filter(([, text]) => /<AdminLayout\b/.test(text));

/** The markup between the layout's opening tag and the first real element inside it, skipping `{cond && (`. */
function firstElementInside(text: string): string {
  const open = /<AdminLayout\b(?:[^>{]|\{[^}]*\})*>/.exec(text);
  if (!open) return '';
  const rest = text.slice(open.index + open[0].length);
  return /<([a-zA-Z][\w-]*)\b[^>]*>/.exec(rest)?.[0] ?? '';
}

describe('AdminLayout', () => {
  it('renders the title as the h1 on the account line, defaulting to the tab title', () => {
    expect(LAYOUT).toMatch(/const \{ title, heading = title \} = Astro\.props;/);
    const h1 = LAYOUT.indexOf('<h1');
    const name = LAYOUT.indexOf('userDisplayName(session?.profile, session?.user.email)');
    const logout = LAYOUT.indexOf('action="/api/logout"');
    expect(h1).toBeGreaterThan(-1);
    expect(LAYOUT.match(/<h1\b/g)).toHaveLength(1);
    expect(LAYOUT).toMatch(/<h1 class="font-display text-4xl"[^>]*>\{heading\}<\/h1>/);
    // Title first on the line, so it leads when the row wraps on a phone.
    expect(h1).toBeLessThan(name);
    expect(name).toBeLessThan(logout);
  });

  it('puts exactly "← Back to Dashboard" above the header, off the dashboard only', () => {
    expect(LAYOUT).toMatch(/>\s*← Back to Dashboard\s*</);
    expect(LAYOUT).not.toContain('← Back to dashboard');
    expect(LAYOUT.indexOf('← Back to Dashboard')).toBeLessThan(LAYOUT.indexOf('<h1'));
    expect(LAYOUT).toMatch(/\{!onDashboard && \(\s*<a\s+href="\/admin"/);
  });

  it('uses the public pages’ top spacing', () => {
    expect(LAYOUT).toMatch(/class="mx-auto max-w-6xl px-6 pb-24 pt-8"/);
    expect(LAYOUT).not.toMatch(/\bpt-28\b|\bsm:pt-36\b/);
  });
});

describe('admin pages', () => {
  it('finds every admin page that uses the layout', () => {
    expect(LAYOUT_PAGES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(LAYOUT_PAGES.map(([path]) => path))('%s has no title of its own', (path) => {
    expect(PAGES[path]).not.toMatch(/<h1\b/);
    // A heading that isn't the tab title is passed to the layout instead.
    expect(PAGES[path]).toMatch(/<AdminLayout\s+title=/);
  });

  it.each(LAYOUT_PAGES.map(([path]) => path))('%s keeps no subtitle paragraph under the title', (path) => {
    const first = firstElementInside(PAGES[path]);
    // The first thing in the page body may be a notice, a toolbar or a back link, never a muted description.
    expect(first).not.toMatch(/^<p\b[^>]*\btext-white\/60\b/);
    expect(first).not.toMatch(/^<p\b[^>]*\bmt-2\b/);
  });

  it('passes `heading` where the title differs from the tab title', () => {
    expect(PAGES['/src/pages/admin/rulesets/index.astro']).toContain(
      '<AdminLayout title="Rulesets" heading="Scoring Rulesets">',
    );
    expect(PAGES['/src/pages/admin/champions/hall-of-fame/[driverId].astro']).toContain(
      'heading={driverName}',
    );
  });
});
