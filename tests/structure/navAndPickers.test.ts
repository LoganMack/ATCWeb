/**
 * Top navigation and section pickers (nav-admin-polish FR6, BR6.1-BR6.7): header order, the Roster, Stats
 * and History menus with their phone-only items, the History and Stats pickers, and the Advanced Stats page.
 */
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_VIEW_LABELS,
  ADVANCED_VIEWS,
  calculatorFragmentQuery,
  calculatorQuery,
  ratingQuery,
  resolveAdvancedView,
} from '../../src/lib/advancedStatsViews';

// Line endings normalised, so a Windows checkout reads the same as CI.
const SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);

const NAV = SRC['/src/components/Nav.astro'];
// Scripts too, for the importer check: a side-menu script must load from the nav only.
const ALL_SRC = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.{astro,ts}', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path, text.replace(/\r\n/g, '\n')]),
);
const HISTORY_TABS = SRC['/src/components/HistoryTabs.astro'];
const STATS_TABS = SRC['/src/components/StatsTabs.astro'];
const ADVANCED = SRC['/src/pages/advanced-stats.astro'];
const SORTABLE = (
  import.meta.glob('/src/scripts/sortable-table.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['/src/scripts/sortable-table.ts'].replace(/\r\n/g, '\n');

/** The nav's `links` array source, from its declaration to the closing `];`. */
const linksBlock = NAV.slice(
  NAV.indexOf('const links: NavLink[] = ['),
  NAV.indexOf('];', NAV.indexOf('const links')),
);

/** Top-level labels in order: entries indented by exactly two or four spaces with a top-level `label`. */
function topLevelLabels(): string[] {
  const labels: string[] = [];
  for (const m of linksBlock.matchAll(/^ {2}\{ href: [^,]+, label: '([^']+)'|^ {4}label: '([^']+)'/gm)) {
    labels.push(m[1] ?? m[2]);
  }
  return labels;
}

/** The menu items of the top-level link with this label, as `href label [mobile]` strings. */
function menuOf(label: string): string[] {
  const start = linksBlock.indexOf(`label: '${label}',\n    menu: [`);
  expect(start, label).toBeGreaterThan(-1);
  const body = linksBlock.slice(start, linksBlock.indexOf('],', start));
  // A side menu's `, submenu: NAME` is skipped here; the literal assertions below pin each constant.
  return [
    ...body.matchAll(/\{ href: '([^']+)', label: '([^']+)'(, mobile: true)?(?:, submenu: [A-Z_]+)? \}/g),
  ].map((m) => `${m[1]} ${m[2]}${m[3] ? ' mobile' : ''}`);
}

describe('top navigation (BR6.1-BR6.4)', () => {
  it('lists the header links in the agreed order', () => {
    expect(topLevelLabels()).toEqual([
      'News',
      'Calendar',
      'Results',
      'Standings',
      'Roster',
      'Stats',
      'History',
      'Media',
      'Rulebook',
      'Shop',
    ]);
  });

  it('opens /roster from Roster and lists Drivers, Teams and Cars, the last two also on phones (BR1.2)', () => {
    expect(linksBlock).toMatch(/href: '\/roster',\s*label: 'Roster',/);
    expect(menuOf('Roster')).toEqual(['/roster Drivers', '/teams Teams mobile', '/cars Cars mobile']);
  });

  it('opens /driver-stats from Stats and lists Drivers, Teams, Seasons, Circuits and Advanced (BR1.1, BR5.7)', () => {
    expect(linksBlock).toMatch(/href: '\/driver-stats',\s*label: 'Stats',/);
    expect(menuOf('Stats')).toEqual([
      '/driver-stats Drivers',
      '/team-stats Teams mobile',
      '/season-stats Seasons mobile',
      '/circuits Circuits mobile',
      '/advanced-stats Advanced mobile',
    ]);
  });

  it('lists Circuits and Cars once each, only under Stats and Roster (BR1.3)', () => {
    expect(linksBlock.match(/'\/circuits'/g)).toHaveLength(1);
    expect(linksBlock.match(/'\/cars'/g)).toHaveLength(1);
  });

  it('lists exactly six History pages, with no stats pages in the History menu', () => {
    expect(menuOf('History')).toEqual([
      '/champions Champions',
      '/hall-of-fame Hall of Fame',
      '/awards Awards',
      '/incidents Incidents',
      '/kudos Kudos mobile',
      '/interviews Interviews mobile',
    ]);
    expect(linksBlock).not.toContain('Driver Stats');
  });
});

describe('desktop side menus (nav-side-menus BR1.1-BR1.12, NFR4.1, NFR5.2-NFR5.4)', () => {
  /** The desktop link row, from its `<nav class="hidden` to its closing tag. */
  const desktop = NAV.slice(
    NAV.indexOf('<nav class="hidden'),
    NAV.indexOf('</nav>', NAV.indexOf('<nav class="hidden')),
  );
  const row = desktop.slice(desktop.indexOf('data-nav-side>') - 200, desktop.indexOf('data-nav-side-link>'));
  const panelClass =
    /<div\s+id=\{sideMenuId[\s\S]*?data-nav-side-panel\s+class="([^"]+)"/.exec(desktop)?.[1] ?? '';
  const toggle = /<button\s([^>]*data-nav-side-toggle[^>]*)>/.exec(desktop)?.[1] ?? '';

  it('lists Drivers and Teams under Standings, each with its side menu, parents unchanged (BR1.2, BR1.3, BR1.5)', () => {
    expect(menuOf('Standings')).toEqual([
      '/standings?championship=drivers Drivers',
      '/standings?championship=teams Teams',
    ]);
    expect(linksBlock).toContain(
      "{ href: '/standings?championship=drivers', label: 'Drivers', submenu: DRIVERS_SIDE_MENU }",
    );
    expect(linksBlock).toContain(
      "{ href: '/standings?championship=teams', label: 'Teams', submenu: TEAMS_SIDE_MENU }",
    );
  });

  it('gives Stats > Advanced the side menu read from the view registry (BR1.4, BR1.5)', () => {
    expect(linksBlock).toContain(
      "{ href: '/advanced-stats', label: 'Advanced', mobile: true, submenu: ADVANCED_SIDE_MENU }",
    );
    expect(linksBlock.match(/submenu: /g)).toHaveLength(3);
    expect(NAV).toMatch(/submenu\?: readonly NavSideItem\[\]/);
  });

  it('renders a side-menu row with a named group, its own parent link and toggle (BR1.7, BR1.10)', () => {
    expect(desktop).toContain('{link.menu?.map((item) =>');
    expect(desktop).toContain('item.submenu ? (');
    expect(row).toContain('class="group/side relative');
    expect(row).toMatch(/<a href=\{item\.href\}[^>]*data-nav-side-parent>\{item\.label\}<\/a>/);
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-controls={sideMenuId(link.label, item.label)}');
    expect(toggle).toContain('aria-label={sideMenuToggleLabel(link.label, item.label)}');
    expect(row).toMatch(/<svg[^>]*stroke="currentColor"[^>]*aria-hidden="true"/);
    expect(desktop).toMatch(/role="group"\s+aria-label=\{`\$\{item\.label\} \$\{link\.label\}`\}/);
    // An item without a side menu keeps today's plain link.
    expect(desktop).toContain(
      '<a href={item.href} class="block whitespace-nowrap rounded-md px-3 py-2 text-white/80 transition hover:bg-white/[0.06] hover:text-white">{item.label}</a>',
    );
  });

  it('hides the side panel by default and shows it only through its own row (NFR5.3, NFR5.4, BR1.6, BR1.9, BR1.11)', () => {
    const classes = panelClass.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['invisible', 'opacity-0', 'duration-150']));
    expect(classes).toContain('transition-[opacity,visibility]');
    expect(classes).toEqual(
      expect.arrayContaining([
        'group-hover/side:visible',
        'group-data-[open]/side:visible',
        'group-data-[dismissed]/side:!invisible',
        'group-data-[dismissed]/side:!opacity-0',
        'group-data-[flip]/side:right-full',
      ]),
    );
    // A bare group-hover would open every side menu as soon as the top dropdown opens.
    expect(panelClass).not.toMatch(/(^|\s)group-hover:/);
    expect(panelClass).not.toMatch(/(^|\s)group-focus-within:/);
  });

  it('reuses the dropdown panel and link classes, with no new colour and no outline-none (NFR4.1, NFR5.6)', () => {
    const side = desktop.slice(
      desktop.indexOf('data-nav-side-panel'),
      desktop.indexOf('data-nav-side-link>') + 20,
    );
    expect(side).toContain(
      '<div class="min-w-[11rem] rounded-[10px] border border-white/10 bg-brand-ink p-1.5 shadow-xl">',
    );
    expect(side).toContain(
      'class="block whitespace-nowrap rounded-md px-3 py-2 text-white/80 transition hover:bg-white/[0.06] hover:text-white" data-nav-side-link',
    );
    expect(row + side).not.toContain('outline-none');
    expect(row + side).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('keeps side menus out of the phone menu (BR1.12)', () => {
    const phone = NAV.slice(
      NAV.indexOf('id="mobile-nav"'),
      NAV.indexOf('</nav>', NAV.indexOf('id="mobile-nav"')),
    );
    expect(phone).not.toContain('submenu');
    expect(phone).not.toContain('data-nav-side');
  });

  it('loads the side-menu script from the nav only, and cuts long track names in the Results menu (BR1.13, BR1.14)', () => {
    const script = NAV.slice(NAV.indexOf('<script>'));
    expect(script).toContain("import '../scripts/navSideMenus';");
    expect(script).toContain("import { truncateLabel } from '../lib/truncateLabel';");
    const render = script.slice(
      script.indexOf('function renderNavRounds'),
      script.indexOf('async function loadNavRounds'),
    );
    expect(render).toContain('truncateLabel(r.track)');
    expect(render).toContain('track.textContent = label.text;');
    expect(render).toContain('a.title = r.track;');
    expect(render).toContain(
      "a.setAttribute('aria-label', r.round !== null ? `Round ${r.round} ${r.track}` : r.track);",
    );
    const importers = Object.keys(ALL_SRC).filter((path) =>
      /import ['"](?:\.\.\/)+scripts\/navSideMenus['"]/.test(ALL_SRC[path]),
    );
    expect(importers).toEqual(['/src/components/Nav.astro']);
  });
});

describe('the phone menu (FR4, BR4.1-BR4.3)', () => {
  const panel = NAV.slice(
    NAV.indexOf('id="mobile-nav"'),
    NAV.indexOf('</nav>', NAV.indexOf('id="mobile-nav"')),
  );

  it('lists every links entry: the pages without a menu as chips, then each menu in full under its heading', () => {
    expect(NAV).toContain('const phoneStandalone = links.filter((link) => !link.menu);');
    expect(NAV).toContain('const phoneSections = links.filter((link) => link.menu);');
    expect(panel).toContain('{phoneStandalone.map((link) => (');
    expect(panel).toContain('{phoneSections.map((link) => (');
    // Every menu entry, not only the old phone-only ones.
    expect(panel).toContain('{link.menu!.map((item) => (');
    expect(NAV).not.toContain('item.mobile)');
    expect(panel).toMatch(/<h2 id=\{`mobile-nav-\$\{link\.label\.toLowerCase\(\)\}`\}/);
    expect(panel).toContain('grid grid-cols-2');
  });

  it('caps the panel at the screen below the header and keeps its scroll inside', () => {
    expect(panel).toContain('max-h-[calc(100dvh-4.25rem)]');
    expect(panel).toContain('overflow-y-auto');
    expect(panel).toContain('overscroll-contain');
    expect(panel).toContain('data-testid="mobile-nav"');
    expect(NAV).toContain('window.innerHeight - panel!.getBoundingClientRect().top');
  });

  it('keeps the toggle button and its aria wiring', () => {
    expect(NAV).toMatch(/id="mobile-nav-toggle"\s+aria-expanded="false"\s+aria-controls="mobile-nav"/);
    expect(NAV).toContain("toggle!.setAttribute('aria-expanded', String(open));");
  });
});

describe('section pickers (BR6.5, BR6.6)', () => {
  it('gives the History picker the same six pages', () => {
    const hrefs = [...HISTORY_TABS.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/champions', '/hall-of-fame', '/awards', '/incidents', '/kudos', '/interviews']);
  });

  it('puts the five-option Stats picker on the five stats pages and no History picker there (BR5.7)', () => {
    const options = [...STATS_TABS.matchAll(/\{ key: '(\w+)', href: '([^']+)', label: '([^']+)' \}/g)].map(
      (m) => `${m[2]} ${m[3]}`,
    );
    expect(options).toEqual([
      '/driver-stats Drivers',
      '/team-stats Teams',
      '/season-stats Seasons',
      '/circuits Circuits',
      '/advanced-stats Advanced',
    ]);
    expect(STATS_TABS).toContain('data-testid="stats-section-picker"');
    const pages: Record<string, string> = {
      '/src/pages/driver-stats.astro': 'drivers',
      '/src/pages/team-stats.astro': 'teams',
      '/src/pages/season-stats.astro': 'seasons',
      '/src/pages/circuits.astro': 'circuits',
      '/src/pages/advanced-stats.astro': 'advanced',
    };
    for (const [page, key] of Object.entries(pages)) {
      expect(SRC[page], page).toContain(`<StatsTabs active="${key}" />`);
      expect(SRC[page], page).not.toContain('HistoryTabs');
    }
  });

  it('gives Advanced Stats a Compare filter card with View, Class and Season (FR4.1)', () => {
    expect(ADVANCED).toContain('<Layout title="Advanced Stats"');
    expect(ADVANCED).not.toMatch(/coming soon/i);
    expect(ADVANCED).toContain('data-testid="compare-filters"');
    expect(ADVANCED).toMatch(/<span[^>]*>View<\/span>/);
    expect(ADVANCED).toContain('<ClassFilterSelect options={classOptions} compareNav />');
    expect(ADVANCED).toMatch(/<span[^>]*>Season<\/span>/);
    // On Compare every select carries the picks through compareView.ts, never the site-wide navigate-on-change.
    const compare = ADVANCED.split(/\{view === 'compare' && \(/)
      .slice(1)
      .map((b) => b.split(/\n\s*\)\}\n/)[0]);
    expect(compare.length).toBeGreaterThanOrEqual(2);
    for (const branch of compare) expect(branch).not.toContain('data-navigate-on-change');
    expect(ADVANCED.match(/data-compare-nav/g)?.length).toBeGreaterThanOrEqual(2);
    // The fragment address is built from the resolved filters, so the picks never reach it.
    expect(ADVANCED).toContain('data-fragment-url={`/advanced-stats/fragment${query}`}');
    expect(ADVANCED).not.toContain('Astro.url.search}');
  });

  it('offers the four views in the View select, Compare first and Lineup Changes last (points-calc FR1.1, FR1.5; lineup-changes BR1.1)', () => {
    expect(ADVANCED_VIEWS).toEqual(['compare', 'contenders', 'irating', 'lineups']);
    expect(ADVANCED_VIEWS.map((v) => ADVANCED_VIEW_LABELS[v])).toEqual([
      'Compare',
      'Points Contenders',
      'Series iRating',
      'Lineup Changes',
    ]);
    expect(resolveAdvancedView('irating')).toBe('irating');
    expect(resolveAdvancedView('lineups')).toBe('lineups');
    expect(resolveAdvancedView('Lineups')).toBe('compare');
    // Points Scenarios is gone; its old links open Points Contenders.
    expect(resolveAdvancedView('scenarios')).toBe('contenders');
    expect(ADVANCED).not.toMatch(/Points Scenarios/);
    expect(resolveAdvancedView('Contenders')).toBe('compare');
    expect(resolveAdvancedView(null)).toBe('compare');
    expect(ADVANCED).toContain("resolveAdvancedView(Astro.url.searchParams.get('view'))");
  });

  it('gives Points Contenders Season, Championship and the Scenario Editor, and Series iRating its search and Class (FR1.3, FR1.4)', () => {
    expect(ADVANCED).toContain('data-testid="calculator-season-select"');
    expect(ADVANCED).toContain('data-testid="calculator-championship-select"');
    // The Scenario Editor button sits where Reset edits was, enabled once the bars are drawn.
    expect(ADVANCED).toMatch(
      /<button\s+type="button"\s+class="btn btn-neutral ml-auto"\s+aria-haspopup="dialog"\s+data-scenario-editor-open[^>]*disabled\s*>\s*Scenario Editor\s*<\/button>/,
    );
    expect(ADVANCED).not.toContain('data-calculator-reset');
    expect(ADVANCED).not.toContain('data-calculator-view-select');
    expect(ADVANCED).toContain('data-testid="rating-class-select"');
    // The search box is the site's own, right after the View select (irating-chart BR1.15).
    expect(ADVANCED).toMatch(
      /<\/select>\s*\)\}\s*<\/label>\s*\{view === 'irating' && \(\s*<input\s+type="search"\s+aria-label="Search drivers"[^>]*class="search-input [^"]*"[^>]*data-rating-search/,
    );
    expect(ADVANCED).toContain('data-fragment-url={pointsFragmentUrl}');
    expect(ADVANCED).toContain('data-fragment-url={ratingsFragmentUrl}');
    expect(calculatorQuery(18, 'overall')).toBe('?view=contenders&season=18');
    expect(calculatorQuery(18, 'delta_team')).toBe('?view=contenders&season=18&championship=delta_team');
    expect(calculatorFragmentQuery(18, 'overall')).toBe('?season=18');
    expect(ratingQuery('overall')).toBe('?view=irating');
    expect(ratingQuery('gamma', false)).toBe('?class=Gamma');
  });
});

describe('class filters (FR3, BR3.1, BR3.7, BR3.8)', () => {
  const CLASS_SELECT = SRC['/src/components/ClassFilterSelect.astro'];
  const DRIVER_STATS = SRC['/src/pages/driver-stats.astro'];
  const HOF = SRC['/src/pages/hall-of-fame/fragment.astro'];
  const PROFILE = SRC['/src/pages/drivers/[id]/fragment.astro'];

  it('gives Driver Stats the shared five-option Class select', () => {
    expect(DRIVER_STATS).toContain("classFilterOptions('/driver-stats', classFilter, classes)");
    expect(DRIVER_STATS).toContain('<ClassFilterSelect options={classOptions} />');
    expect(CLASS_SELECT).toContain('data-testid="class-filter-select"');
    expect(CLASS_SELECT).toMatch(/data-navigate-on-change=\{compareNav \? undefined : ''\}/);
  });

  it('renders the Hall of Fame cards in all five variants', () => {
    expect(HOF).toContain("['Overall', 'Combined', 'Alpha', 'Gamma', 'Delta']");
  });

  it('gives the profile Seasons tab a CSS-only Overall / Class toggle that opens on Overall', () => {
    const toggle = PROFILE.slice(PROFILE.indexOf('data-seasons-toggle'));
    expect(toggle).toMatch(/id="seasons-mode-overall"[^>]*checked/);
    expect(toggle).toContain('id="seasons-mode-class"');
    expect(toggle).toContain('peer-checked/class:[&_.season-count-class]:table-cell');
    expect(toggle).toContain('peer-checked/class:[&_.season-count-overall]:hidden');
    // Fragment scripts never run, so the toggle must not need one.
    expect(PROFILE).not.toMatch(/<script(?![^>]*type="application\/json")/);
  });

  it('gives the Races tab a CSS-only Overall / Class toggle over paired start, finish and margin cells (BR3.1-BR3.4)', () => {
    const toggle = PROFILE.slice(PROFILE.indexOf('data-races-toggle'));
    expect(toggle).toMatch(/id="races-mode-overall"[^>]*checked[^>]*data-sort-reset/);
    expect(toggle).toMatch(/id="races-mode-class"[^>]*data-sort-reset/);
    expect(toggle).toContain('[&_.race-class]:hidden peer-checked/class:[&_.race-class]:table-cell');
    expect(toggle).toContain('peer-checked/class:[&_.race-overall]:hidden');
    for (const key of ['start', 'classStart', 'finish', 'classFinish', 'margin', 'classMargin']) {
      expect(toggle, key).toContain(`data-sort-key="${key}"`);
    }
  });

  it('gives the Bests tab an Overall / Gamma / Delta toggle over three tables, Overall first (BR2.3, BR2.4)', () => {
    const toggle = PROFILE.slice(PROFILE.indexOf('data-bests-toggle'));
    expect(toggle).toContain('checked={i === 0}');
    expect(toggle).toContain('data-testid={`bests-filter-${f.key}`}');
    expect(toggle).toContain('data-bests-table={f.key}');
    for (const key of ['overall', 'gamma', 'delta']) {
      expect(PROFILE, key).toContain(`showOn: 'peer-checked/${key}:block'`);
    }
  });

  it('shows a focus ring on the Seasons and Splits toggles and clears a sort the switch hides', () => {
    const toggle = PROFILE.slice(PROFILE.indexOf('data-seasons-toggle'));
    // Overall is on the Seasons, Races, Splits and Bests toggles; Class on the first three.
    for (const [peer, uses] of [
      ['overall', 4],
      ['class', 3],
    ] as const) {
      // A 2px ring in the label's own text colour (currentColor), the width and offset of the site's ring.
      const ring = `peer-focus-visible/${peer}:outline peer-focus-visible/${peer}:outline-2 peer-focus-visible/${peer}:outline-offset-2`;
      expect(toggle).toContain(ring);
      // Every toggle's labels share the same focus style.
      expect(PROFILE.split(ring)).toHaveLength(uses + 1);
    }
    expect(toggle).toMatch(/id="seasons-mode-overall"[^>]*data-sort-reset/);
    expect(toggle).toMatch(/id="seasons-mode-class"[^>]*data-sort-reset/);
    // The reset lives in the site-wide sort script, loaded by the layout, not in the fragment.
    expect(SORTABLE).toContain("closest('[data-sort-reset]')");
    expect(SORTABLE).toContain('getClientRects().length > 0');
    expect(SRC['/src/layouts/Layout.astro']).toContain(
      '<script src="../scripts/sortable-table.ts"></script>',
    );
  });
});
