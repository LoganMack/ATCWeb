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
  return [...body.matchAll(/\{ href: '([^']+)', label: '([^']+)'(, mobile: true)? \}/g)].map(
    (m) => `${m[1]} ${m[2]}${m[3] ? ' mobile' : ''}`,
  );
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
    const compare = ADVANCED.split(/\{view === 'compare' && \(/).slice(1).map((b) => b.split(/\n\s*\)\}\n/)[0]);
    expect(compare.length).toBeGreaterThanOrEqual(2);
    for (const branch of compare) expect(branch).not.toContain('data-navigate-on-change');
    expect(ADVANCED.match(/data-compare-nav/g)?.length).toBeGreaterThanOrEqual(2);
    // The fragment address is built from the resolved filters, so the picks never reach it.
    expect(ADVANCED).toContain('data-fragment-url={`/advanced-stats/fragment${query}`}');
    expect(ADVANCED).not.toContain('Astro.url.search}');
  });

  it('offers the four views in the View select, Compare first (points-calc FR1.1, FR1.5)', () => {
    expect(ADVANCED_VIEWS).toEqual(['compare', 'contenders', 'scenarios', 'irating']);
    expect(ADVANCED_VIEWS.map((v) => ADVANCED_VIEW_LABELS[v])).toEqual([
      'Compare',
      'Points Contenders',
      'Points Scenarios',
      'Series iRating',
    ]);
    expect(resolveAdvancedView('irating')).toBe('irating');
    expect(resolveAdvancedView('Contenders')).toBe('compare');
    expect(resolveAdvancedView(null)).toBe('compare');
    expect(ADVANCED).toContain("resolveAdvancedView(Astro.url.searchParams.get('view'))");
  });

  it('gives the calculator views Season, Championship and Reset edits, and Series iRating its Class (FR1.3, FR1.4)', () => {
    expect(ADVANCED).toContain('data-testid="calculator-season-select"');
    expect(ADVANCED).toContain('data-testid="calculator-championship-select"');
    expect(ADVANCED).toMatch(/<button type="button" class="btn ml-auto" data-calculator-reset[^>]*disabled>/);
    expect(ADVANCED).toContain('data-testid="rating-class-select"');
    // Contenders and Scenarios swap in the page through pointsCalculator.ts, so the edits survive.
    expect(ADVANCED).toContain('data-calculator-view-select');
    expect(ADVANCED).toContain('data-fragment-url={pointsFragmentUrl}');
    expect(ADVANCED).toContain('data-fragment-url={ratingsFragmentUrl}');
    expect(calculatorQuery('scenarios', 18, 'overall')).toBe('?view=scenarios&season=18');
    expect(calculatorQuery('contenders', 18, 'delta_team')).toBe('?view=contenders&season=18&championship=delta_team');
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
