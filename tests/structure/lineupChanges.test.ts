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

  it('marks up the board for screen readers: a labelled figure, labelled lists, and a hidden SVG and label line', () => {
    expect(FRAGMENT).toMatch(/<figure\s+class="[^"]*\bhidden\b[^"]*\bmd:block\b[^"]*"/);
    expect(FRAGMENT).toContain(
      'aria-label={`Lineup changes from ${board.previousLabel} to ${board.currentLabel}`}',
    );
    expect(FRAGMENT).toContain('aria-label={`${label} lineups`}');
    expect(FRAGMENT).toMatch(/<svg\s+aria-hidden="true"/);
    expect(FRAGMENT).toMatch(/aria-hidden="true" data-lineup-label/);
    expect(FRAGMENT).toContain('<span class="sr-only">{seat.srText}</span>');
    expect(FRAGMENT).toContain('data-lineup-cards');
  });

  it('keeps the highlight and filter script to createElement and textContent, with no fetch or innerHTML', () => {
    const script = SRC['/src/scripts/lineupBoard.ts'];
    expect(script).toContain('textContent');
    expect(script).toContain("document.createElement('input')");
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|fetch\(/);
    // Only the import-free geometry module reaches the browser, never the server-side board code.
    expect(script).toContain("from '../lib/lineups/geometry';");
    expect(script).not.toMatch(/lib\/lineups\/(board|load|classify)/);
    expect(SRC['/src/lib/lineups/geometry.ts']).not.toMatch(/^import /m);
  });
});

describe('the board polish (full width, dense rows, team blocks, no counts line)', () => {
  const figure = FRAGMENT.slice(FRAGMENT.indexOf('<figure'), FRAGMENT.indexOf('</figure>'));

  it('breaks the board out of the page column from md up, while the title stays in it', () => {
    expect(FRAGMENT).toMatch(
      /<figure\s+class="[^"]*md:relative md:left-1\/2 md:block md:w-\[calc\(100vw-3rem\)\] md:-translate-x-1\/2"/,
    );
    expect(FRAGMENT).toContain(
      '<h2 id="lineups-heading" class="font-display text-2xl sm:text-3xl">Lineup Changes</h2>',
    );
    expect(FRAGMENT.indexOf('<h2')).toBeLessThan(FRAGMENT.indexOf('<figure'));
    // The columns keep their page-column width; the extra width spreads the lines out.
    expect(FRAGMENT).toContain('grid-cols-[minmax(0,31.5rem)_minmax(3rem,1fr)_minmax(0,31.5rem)]');
    // The filter card keeps its own classes.
    expect(SHELL).toContain(
      'class="reveal mt-12 relative z-30 rounded-xl border border-white/10 bg-brand-ink p-4"',
    );
  });

  it('draws seats as h-5 text-xs rows with 16px logos, a gap-1 column and no colour stripes', () => {
    expect(figure).toContain("'flex h-5 items-center gap-2 px-2 text-xs'");
    expect(figure).toContain('size="h-4 w-4"');
    expect(figure).toContain("'row-start-2 flex flex-col gap-1'");
    expect(figure).not.toMatch(/h-9|h-6 w-6|border-[lr]-4|\bstripe\b|mt-3/);
  });

  it('puts each group on one block of its team colour from --team, else a neutral block', () => {
    expect(FRAGMENT).toContain(
      "const teamBlock = 'bg-[color:color-mix(in_srgb,var(--team)_25%,transparent)]';",
    );
    expect(FRAGMENT).toContain("const neutralBlock = 'bg-[rgb(var(--fg)/0.06)]';");
    // Square corners: one solid block per team, as the owner asked.
    expect(figure).toContain('class:list={[group.colour ? teamBlock : neutralBlock]}');
    expect(figure).toMatch(/data-group=\{group\.kind\}\s+data-team=\{group\.teamKey \?\? undefined\}/);
    expect(figure).toContain('data-team={seat.teamKey ?? undefined}');
  });

  it('drops the counts line under the board and the phone cards, keeping only the no-changes line', () => {
    expect(FRAGMENT).not.toContain('<figcaption');
    expect(FRAGMENT).not.toContain('.summary');
    for (const [path, text] of LIB) expect(text, path).not.toMatch(/moved team|lineupSummary/);
    expect(FRAGMENT).toContain('{board.noChanges && <p');
    expect(FRAGMENT.match(/data-lineup-none/g)).toHaveLength(2);
    expect(FRAGMENT).toContain('<ul class="hidden" data-lineup-teams>');
    expect(FRAGMENT).toMatch(/data-team=\{card\.teamKey \?\? undefined\}/);
    expect(FRAGMENT).toContain('data-lineup-left-card');
  });
});

describe('the Teams filter in the shell', () => {
  const at = SHELL.indexOf('data-testid="lineup-season-select"');
  const teams = SHELL.slice(
    SHELL.indexOf('data-lineup-team-dropdown'),
    SHELL.indexOf("{!loadError && view === 'compare'"),
  );

  it('sits after the lineups Season select, on that view only', () => {
    expect(at).toBeGreaterThan(-1);
    expect(SHELL.indexOf('data-lineup-team-dropdown')).toBeGreaterThan(at);
    expect(SHELL).toMatch(
      /\{view === 'lineups' && \(\s*<div class="flex flex-col gap-1\.5 sm:w-44" data-lineup-team-dropdown/,
    );
    expect(SHELL.match(/data-lineup-team-dropdown/g)).toHaveLength(1);
  });

  it('has a disabled toggle, a hidden panel with a search box, a checked Select All and an empty list', () => {
    expect(teams).toMatch(
      /<button[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*data-lineup-team-toggle[^>]*disabled\s*>/,
    );
    expect(teams).toContain('>All teams</span>');
    expect(teams).toMatch(/class="absolute [^"]*\bhidden\b[^"]*"\s+data-lineup-team-panel/);
    expect(teams).toMatch(/<input\s+type="search"\s+aria-label="Search teams"/);
    expect(teams).toContain(
      '<input type="checkbox" checked data-lineup-team-all data-testid="lineup-team-all" />',
    );
    expect(teams).toContain('Select All');
    expect(teams).toMatch(/<div class="[^"]*" data-lineup-team-list data-testid="lineup-team-list"><\/div>/);
    for (const id of ['lineup-team-toggle', 'lineup-team-panel', 'lineup-team-search', 'lineup-team-all'])
      expect(teams).toContain(`data-testid="${id}"`);
  });
});
