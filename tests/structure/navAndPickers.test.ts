/**
 * Top navigation and section pickers (nav-admin-polish FR6, BR6.1-BR6.7): header order, the Roster, Stats
 * and History menus with their phone-only items, the History and Stats pickers, and the Advanced Stats page.
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

const NAV = SRC['/src/components/Nav.astro'];
const HISTORY_TABS = SRC['/src/components/HistoryTabs.astro'];
const STATS_TABS = SRC['/src/components/StatsTabs.astro'];
const ADVANCED = SRC['/src/pages/advanced-stats.astro'];

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

  it('opens /roster from Roster and lists Drivers and Teams, Teams also on phones', () => {
    expect(linksBlock).toMatch(/href: '\/roster',\s*label: 'Roster',/);
    expect(menuOf('Roster')).toEqual(['/roster Drivers', '/teams Teams mobile']);
  });

  it('opens /driver-stats from Stats and lists Drivers, Teams and Advanced, the last two also on phones', () => {
    expect(linksBlock).toMatch(/href: '\/driver-stats',\s*label: 'Stats',/);
    expect(menuOf('Stats')).toEqual([
      '/driver-stats Drivers',
      '/team-stats Teams mobile',
      '/advanced-stats Advanced mobile',
    ]);
  });

  it('lists exactly six History pages, with no stats pages or Circuits in any menu', () => {
    expect(menuOf('History')).toEqual([
      '/champions Champions',
      '/hall-of-fame Hall of Fame',
      '/awards Awards',
      '/incidents Incidents',
      '/kudos Kudos mobile',
      '/interviews Interviews mobile',
    ]);
    expect(linksBlock).not.toContain("'/circuits'");
    expect(linksBlock).not.toContain('Driver Stats');
    // The phone menu adds each link's `mobile` items under it.
    expect(NAV).toContain('link.menu?.filter((item) => item.mobile)');
  });
});

describe('section pickers (BR6.5, BR6.6)', () => {
  it('gives the History picker the same six pages', () => {
    const hrefs = [...HISTORY_TABS.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/champions', '/hall-of-fame', '/awards', '/incidents', '/kudos', '/interviews']);
  });

  it('puts the four-option Stats picker on the four stats pages and no History picker there', () => {
    const options = [...STATS_TABS.matchAll(/\{ key: '(\w+)', href: '([^']+)', label: '([^']+)' \}/g)].map(
      (m) => `${m[2]} ${m[3]}`,
    );
    expect(options).toEqual([
      '/driver-stats Drivers',
      '/team-stats Teams',
      '/circuits Circuits',
      '/advanced-stats Advanced',
    ]);
    expect(STATS_TABS).toContain('data-testid="stats-section-picker"');
    const pages: Record<string, string> = {
      '/src/pages/driver-stats.astro': 'drivers',
      '/src/pages/team-stats.astro': 'teams',
      '/src/pages/circuits.astro': 'circuits',
      '/src/pages/advanced-stats.astro': 'advanced',
    };
    for (const [page, key] of Object.entries(pages)) {
      expect(SRC[page], page).toContain(`<StatsTabs active="${key}" />`);
      expect(SRC[page], page).not.toContain('HistoryTabs');
    }
  });

  it('serves Advanced Stats as a coming-soon page that reads no data of its own', () => {
    expect(ADVANCED).toContain('<Layout title="Advanced Stats"');
    expect(ADVANCED).toContain('data-testid="advanced-stats-coming-soon"');
    expect(ADVANCED).toMatch(/coming soon/i);
    expect(ADVANCED).not.toMatch(/lib\/db\/|restGet|await /);
  });
});
