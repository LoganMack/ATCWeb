/**
 * The desktop nav's side-menu data (nav-side-menus BR1.2-BR1.4, BR1.10; NFR2.1, NFR3.2): the fixed Standings
 * menus, the Advanced menu read from the view registry, the panel ids and toggle labels, and an edge-cache key
 * of its own for every link.
 */
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SIDE_MENU,
  DRIVERS_SIDE_MENU,
  TEAMS_SIDE_MENU,
  sideMenuId,
  sideMenuToggleLabel,
} from '../../src/lib/navMenu';
import { ADVANCED_VIEW_LABELS, ADVANCED_VIEWS } from '../../src/lib/advancedStatsViews';
import { cacheKeyUrl } from '../../src/lib/edgeCache';

const ALL = [...DRIVERS_SIDE_MENU, ...TEAMS_SIDE_MENU, ...ADVANCED_SIDE_MENU];
const asPairs = (menu: readonly { href: string; label: string }[]) => menu.map((i) => `${i.href} ${i.label}`);

describe('the Standings side menus (BR1.2, BR1.3)', () => {
  it('gives Drivers Overall, Gamma and Delta, in that order', () => {
    expect(asPairs(DRIVERS_SIDE_MENU)).toEqual([
      '/standings?championship=drivers Overall',
      '/standings?championship=drivers&class=Gamma Gamma',
      '/standings?championship=drivers&class=Delta Delta',
    ]);
  });

  it('gives Teams Overall and Delta, in that order', () => {
    expect(asPairs(TEAMS_SIDE_MENU)).toEqual([
      '/standings?championship=teams Overall',
      '/standings?championship=teams&class=Delta Delta',
    ]);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(DRIVERS_SIDE_MENU)).toBe(true);
    expect(Object.isFrozen(TEAMS_SIDE_MENU[0])).toBe(true);
    expect(() =>
      (DRIVERS_SIDE_MENU as { href: string; label: string }[]).push({ href: '/x', label: 'X' }),
    ).toThrow();
  });
});

describe('the Advanced side menu (BR1.4)', () => {
  it('lists every registry view in order, with its registry label and address', () => {
    expect(ADVANCED_SIDE_MENU).toEqual(
      ADVANCED_VIEWS.map((v) => ({ href: `/advanced-stats?view=${v}`, label: ADVANCED_VIEW_LABELS[v] })),
    );
  });

  it('today holds the four views, ending with Lineup Changes', () => {
    expect(ADVANCED_SIDE_MENU.map((i) => i.label)).toEqual([
      'Compare',
      'Points Contenders',
      'Series iRating',
      'Lineup Changes',
    ]);
    expect(ADVANCED_SIDE_MENU.at(-1)?.href).toBe('/advanced-stats?view=lineups');
  });
});

describe('every side link (NFR2.1, NFR3.2)', () => {
  it('is a same-site path: starts with one slash, never two', () => {
    for (const { href } of ALL) {
      expect(href, href).toMatch(/^\//);
      expect(href, href).not.toMatch(/^\/\//);
    }
  });

  it('keeps all of its query parameters in the edge-cache key, so each gets its own cached copy', () => {
    for (const { href } of ALL) {
      const url = new URL(href, 'https://example.test');
      const key = new URL(cacheKeyUrl(url));
      expect([...key.searchParams].sort(), href).toEqual([...url.searchParams].sort());
    }
    const keys = ALL.map(({ href }) => cacheKeyUrl(new URL(href, 'https://example.test')));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('panel ids and toggle labels (BR1.10)', () => {
  it('names each panel after its section and item', () => {
    expect(sideMenuId('Standings', 'Drivers')).toBe('nav-side-standings-drivers');
    expect(sideMenuId('Standings', 'Teams')).toBe('nav-side-standings-teams');
    expect(sideMenuId('Stats', 'Advanced')).toBe('nav-side-stats-advanced');
    expect(sideMenuId('Some Section', 'Hall of Fame')).toBe('nav-side-some-section-hall-of-fame');
  });

  it('says what each toggle shows', () => {
    expect(sideMenuToggleLabel('Standings', 'Drivers')).toBe('Show Drivers standings views');
    expect(sideMenuToggleLabel('Standings', 'Teams')).toBe('Show Teams standings views');
    expect(sideMenuToggleLabel('Stats', 'Advanced')).toBe('Show Advanced stats views');
  });
});
