/**
 * Lineup Changes wiring (U9; NFR7.4, BR1.1, BR1.2, BR1.15, BR1.20): the shell reads rosters only on its own
 * view and passes the resolved season to the fragment, imports the highlight script (the layout never does),
 * the fragment reads only through loadLineups, escapes everything through Astro, and writes team colours only
 * as the --team custom property.
 */
import { describe, expect, it } from 'vitest';
import { lineupQuery } from '../../src/lib/advancedStatsViews';

const SRC = import.meta.glob(
  [
    '/src/pages/advanced-stats.astro',
    '/src/pages/advanced-stats/lineups/fragment.astro',
    '/src/layouts/**/*.astro',
    '/src/lib/lineups/*.ts',
    '/src/scripts/lineupBoard.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const SHELL = SRC['/src/pages/advanced-stats.astro'];
const FRAGMENT = SRC['/src/pages/advanced-stats/lineups/fragment.astro'];
const LIB = Object.entries(SRC).filter(([path]) => path.startsWith('/src/lib/lineups/'));

describe('the Advanced Stats shell (BR1.1, BR1.2, NFR1.3)', () => {
  it('resolves the view before its reads and reads the rosters only on view=lineups, last in the tuple and the array', () => {
    const viewAt = SHELL.indexOf("const view = resolveAdvancedView(Astro.url.searchParams.get('view'));");
    const readsAt = SHELL.indexOf('await Promise.all([');
    expect(viewAt).toBeGreaterThan(-1);
    expect(viewAt).toBeLessThan(readsAt);
    expect(SHELL).toContain('[classes, seasons, bannerUrl, lineupRosters] = await Promise.all([');
    const reads = SHELL.slice(readsAt, SHELL.indexOf(']);', readsAt));
    const order = ['getDriverClasses(', 'getSeasons(', 'getPageBanners(', 'getAllTeamRosters('].map((r) =>
      reads.indexOf(r),
    );
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(reads).toContain("view === 'lineups' ? getAllTeamRosters(supabaseEnv) : Promise.resolve([])");
    expect(SHELL.match(/getAllTeamRosters\(/g)).toHaveLength(1);
  });

  it('gives Lineup Changes its Season select and loads the fragment with the resolved season', () => {
    expect(SHELL).toMatch(
      /\{view === 'lineups' && \(\s*<label[^>]*>\s*<span class=\{labelClass\}>Season<\/span>/,
    );
    expect(SHELL).toContain('data-navigate-on-change data-logo-select data-testid="lineup-season-select"');
    expect(SHELL).toContain('<div data-lineups-view data-fragment-url={lineupsFragmentUrl}>');
    expect(SHELL).toContain(
      '`/advanced-stats/lineups/fragment${lineupQuery(lineupSeason?.number ?? null, false)}`',
    );
    expect(SHELL).toContain("bindFragment('[data-lineups-view]'");
    expect(SHELL).toContain('lineups: `/advanced-stats${lineupQuery(null)}`');
    expect(lineupQuery(null)).toBe('?view=lineups');
    expect(lineupQuery(18)).toBe('?view=lineups&season=18');
    expect(lineupQuery(18, false)).toBe('?season=18');
    expect(lineupQuery(null, false)).toBe('');
  });

  it('imports the highlight script from the page, never from a layout', () => {
    expect(SHELL).toContain("import '../scripts/lineupBoard';");
    for (const [path, text] of Object.entries(SRC)) {
      if (path.startsWith('/src/layouts/')) expect(text, path).not.toContain('lineupBoard');
    }
  });
});

describe('the lineups fragment (BR1.15, BR1.20, NFR2.2, NFR3.3)', () => {
  it('reads only through loadLineups, never the raw drivers table', () => {
    expect(FRAGMENT).toContain("Astro.url.searchParams.get('season')");
    expect(FRAGMENT).toContain('await loadLineups(supabaseEnv,');
    expect(FRAGMENT).not.toMatch(/lib\/db\/(?!client')/);
    for (const [path, text] of [['fragment', FRAGMENT], ...LIB]) {
      expect(text, path).not.toContain('getDriversBasic');
      expect(text, path).not.toMatch(/['"`]drivers\?/);
    }
  });

  it('uses no set:html, writes no inline style but --team, and is cached unless the read failed', () => {
    expect(FRAGMENT).not.toContain('set:html');
    expect(FRAGMENT).not.toMatch(/style="/);
    for (const m of FRAGMENT.matchAll(/style=\{([^}]+)\}/g))
      expect(m[1]).toMatch(/^teamStyle\(\w+\.colour\)$/);
    expect(FRAGMENT).toContain('(colour ? `--team:${colour}` : undefined)');
    expect(FRAGMENT).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(FRAGMENT).toContain(
      "Astro.response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');",
    );
    expect(FRAGMENT).toContain('if (loadError) markUncacheable(Astro);');
    expect(FRAGMENT).toContain('<LoadError />');
  });

  it('marks up the board for screen readers: a figure, labelled lists, and a hidden SVG and label line', () => {
    expect(FRAGMENT).toMatch(/<figure class="[^"]*hidden md:block" data-lineup-board>/);
    expect(FRAGMENT).toContain('<figcaption');
    expect(FRAGMENT).toContain('aria-label={`${label} lineups`}');
    expect(FRAGMENT).toMatch(/<svg\s+aria-hidden="true"/);
    expect(FRAGMENT).toMatch(/aria-hidden="true" data-lineup-label/);
    expect(FRAGMENT).toContain('<span class="sr-only">{seat.srText}</span>');
    expect(FRAGMENT).toContain('data-lineup-cards');
  });

  it('keeps the highlight script to textContent, with no fetch or innerHTML', () => {
    const script = SRC['/src/scripts/lineupBoard.ts'];
    expect(script).toContain('textContent');
    expect(script).not.toMatch(/innerHTML|fetch\(/);
  });
});
