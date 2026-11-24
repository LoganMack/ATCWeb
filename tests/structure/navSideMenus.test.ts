/**
 * The side menus' module rules (nav-side-menus NFR1.1, NFR3.1-NFR3.3): navMenu.ts stays server only, so the
 * view registry's database module never reaches the browser bundle; truncateLabel.ts has no imports; the
 * script makes no requests; nothing new writes HTML; every side link is a same-site path; and every visitor
 * gets the same side menus.
 */
import { describe, expect, it } from 'vitest';

// Line endings normalised, so a Windows checkout reads the same as CI.
const SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);

const NAV_PATH = '/src/components/Nav.astro';
const NAV = SRC[NAV_PATH];
const NAV_MENU = SRC['/src/lib/navMenu.ts'];
const TRUNCATE = SRC['/src/lib/truncateLabel.ts'];
const SCRIPT = SRC['/src/scripts/navSideMenus.ts'];

/** Every module specifier a file imports or re-exports from. */
const specifiers = (text: string) =>
  [
    ...text.matchAll(
      /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm,
    ),
  ].map((m) => m[1] ?? m[2]);

/** The Nav frontmatter (between the two `---` fences) and its client script. */
const frontmatter = NAV.slice(3, NAV.indexOf('\n---', 3));
const navScript = NAV.slice(NAV.indexOf('<script>'));

describe('module boundaries (NFR1.1)', () => {
  it('finds the three new modules', () => {
    expect(NAV_MENU).toBeDefined();
    expect(TRUNCATE).toBeDefined();
    expect(SCRIPT).toBeDefined();
  });

  it('lets navMenu.ts import only the view registry', () => {
    expect(specifiers(NAV_MENU)).toEqual(['./advancedStatsViews']);
  });

  it('imports navMenu.ts only in the Nav frontmatter, never in a browser script', () => {
    const importers = Object.keys(SRC).filter((path) =>
      specifiers(SRC[path]).some((s) => /\/navMenu$/.test(s)),
    );
    expect(importers).toEqual([NAV_PATH]);
    expect(specifiers(frontmatter)).toContain('../lib/navMenu');
    expect(navScript).not.toContain('navMenu');
    expect(SCRIPT).not.toContain('navMenu');
  });

  it('gives truncateLabel.ts no imports, so it is safe in the browser', () => {
    expect(specifiers(TRUNCATE)).toEqual([]);
  });

  it('makes no request from the side-menu script, and imports nothing into it', () => {
    expect(SCRIPT).not.toMatch(/\bfetch\s*\(/);
    expect(specifiers(SCRIPT)).toEqual([]);
  });
});

describe('no new HTML writes (NFR3.1)', () => {
  it('has no set:html in the nav', () => {
    expect(NAV).not.toContain('set:html');
  });

  it('builds the Results menu and the side menus without innerHTML', () => {
    const render = navScript.slice(
      navScript.indexOf('function renderNavRounds'),
      navScript.indexOf('async function loadNavRounds'),
    );
    expect(render).toContain('createElement');
    expect(render).not.toContain('innerHTML');
    expect(SCRIPT).not.toContain('innerHTML');
    expect(SCRIPT).not.toContain('outerHTML');
    expect(SCRIPT).not.toContain('insertAdjacentHTML');
  });
});

describe('same-site links, the same for every visitor (NFR3.2, NFR3.3)', () => {
  it('writes every navMenu.ts href as a path starting with one slash', () => {
    const hrefs = [...NAV_MENU.matchAll(/href: '([^']*)'/g), ...NAV_MENU.matchAll(/href: '([^']*)' \+/g)].map(
      (m) => m[1],
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    for (const href of hrefs) {
      expect(href, href).toMatch(/^\//);
      expect(href, href).not.toMatch(/^\/\//);
    }
  });

  it('keeps the three side menus in the static links array, outside every admin or session branch', () => {
    const links = NAV.slice(
      NAV.indexOf('const links: NavLink[] = ['),
      NAV.indexOf('];', NAV.indexOf('const links')),
    );
    const all = NAV.match(/submenu: [A-Z_]+/g) ?? [];
    expect(all).toEqual([
      'submenu: DRIVERS_SIDE_MENU',
      'submenu: TEAMS_SIDE_MENU',
      'submenu: ADVANCED_SIDE_MENU',
    ]);
    expect(links.match(/submenu: [A-Z_]+/g)).toEqual(all);
    expect(links).not.toMatch(/showAdminLink|isAdminView|session|Astro\.locals/);
    // The rendered row reads only the item, never who is viewing.
    const desktop = NAV.slice(
      NAV.indexOf('<nav class="hidden'),
      NAV.indexOf('</nav>', NAV.indexOf('<nav class="hidden')),
    );
    expect(desktop).toContain('data-nav-side');
    expect(desktop).not.toMatch(/showAdminLink|isAdminView|session|myDriverId/);
  });
});
