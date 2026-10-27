/**
 * Page loading (BR1.1, BR2.1-BR2.3, BR4.3): the model fragments read the stored round stats through the
 * adapter instead of today's per-race bulk builders; every fragment keeps its URL and the query parameters
 * it reads (the edge cache keys and preload hints match on them); the driver's Awards card is its own
 * fragment with a longer cache and no parameters.
 */
import { describe, expect, it } from 'vitest';
import { cacheKeyUrl, cacheQueryParams } from '../../src/lib/edgeCache';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const PAGES = raw(
  import.meta.glob('/src/pages/**/*.astro', { query: '?raw', import: 'default', eager: true }),
);
const LIB = raw(import.meta.glob('/src/lib/**/*.ts', { query: '?raw', import: 'default', eager: true }));

/** Source without comments, so a builder named in a comment doesn't count as a call. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function page(path: string): string {
  const text = PAGES[`/src/pages/${path}`];
  if (text === undefined) throw new Error(`src/pages/${path} is missing`);
  return code(text);
}

function lib(path: string): string {
  const text = LIB[`/src/lib/${path}`];
  if (text === undefined) throw new Error(`src/lib/${path} is missing`);
  return code(text);
}

/** The body of one exported function, up to the next top-level declaration. */
function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`export (async )?function ${name}\\b`));
  if (start < 0) throw new Error(`${name} not found`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(export |function |async function |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

// Today's per-race builders, which read every score row, raw result and penalty of a season.
const BULK_BUILDERS = [
  'getSeasonOverallContext',
  'computeSeasonStandings',
  'computeOverallSeasonStandings',
  'computeTeamSeasonStandings',
  'getSeasonCarTeamStats',
  'getSeasonDriverExtendedStats',
  'getRaceScoresForSeasonsBulk',
];

/** The builders a source calls (an identifier followed by an opening parenthesis). */
function callsOf(text: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(text));
}

describe('the model fragments read the stored round stats (BR1.1, BR2.1-BR2.3)', () => {
  it('builds the standings drivers views and the home widget through the adapter', () => {
    const standings = page('standings/fragment.astro');
    expect(standings).toMatch(/\bloadDriverStandingsView\s*\(/);
    // Only the Teams view keeps the live per-race path (its rows list every finish).
    const teamsBranch = standings.slice(
      standings.indexOf("championship === 'teams' && !deltaNotActiveForSeason"),
    );
    const driversBranch = standings.slice(
      0,
      standings.indexOf("championship === 'teams' && !deltaNotActiveForSeason"),
    );
    expect(callsOf(driversBranch, BULK_BUILDERS)).toEqual([]);
    expect(teamsBranch).toMatch(/\bcomputeTeamSeasonStandings\s*\(/);

    const home = page('home/fragment.astro');
    expect(home).toMatch(/\bloadHomeStandings\s*\(/);
    expect(callsOf(home, BULK_BUILDERS)).toEqual([]);

    const view = lib('results/standingsView.ts');
    for (const name of ['loadDriverStandingsView', 'loadHomeStandings']) {
      const body = functionBody(view, name);
      expect(body, name).toMatch(/\bloadStoredSeasons\s*\(/);
      // The per-race builders run only after the stored rows were found incomplete.
      const stored = body.slice(0, body.search(/if \(stats\)|if \(!stats\)/));
      expect(callsOf(stored, BULK_BUILDERS), name).toEqual([]);
    }
  });

  it('builds the career pages, the driver profile and the champions from the stored rows', () => {
    const career = lib('results/careerStats.ts');
    expect(career).toMatch(/\bloadStoredSeasons\s*\(/);
    for (const name of [
      'classStandingsFromRounds',
      'overallStandingsFromRounds',
      'teamStandingsFromRounds',
      'carTeamStatsFromRounds',
      'extendedStatsFromRounds',
    ]) {
      expect(career, name).toMatch(new RegExp(`\\b${name}\\s*\\(`));
    }
    // The bulk score read is only the live fallback's (src/lib/results/liveSeasons.ts).
    expect(callsOf(career, ['getRaceScoresForSeasonsBulk', 'getCuratedRaceResultsWithLapStatsBulk'])).toEqual(
      [],
    );
    expect(callsOf(functionBody(career, 'computeDriverCareerStats'), BULK_BUILDERS)).toEqual([]);

    for (const path of [
      'driver-stats/fragment.astro',
      'hall-of-fame/fragment.astro',
      'team-stats/fragment.astro',
    ]) {
      const text = page(path);
      expect(text, path).toMatch(/\bcomputeDriverCareerStats\s*\(/);
      expect(text, path).toMatch(/\bloadCareerRefs\s*\(/);
      expect(callsOf(text, BULK_BUILDERS), path).toEqual([]);
    }

    const champions = lib('results/champions.ts');
    expect(champions).toMatch(/\bloadStoredSeasons\s*\(/);
    expect(champions).toMatch(/\bclassStandingsFromRounds\s*\(/);
    expect(champions).toMatch(/\bteamStandingsFromRounds\s*\(/);
    expect(callsOf(champions, ['getRaceScoresForSeasonsBulk', 'buildSeasonOverallContext'])).toEqual([]);
    // Admin > Champions reads the same function.
    expect(page('admin/site-properties/index.astro')).toMatch(
      /import \{ getChampions \} from '..\/..\/..\/lib\/results\/champions'/,
    );

    const driverPage = lib('driverPage/load.ts');
    const main = functionBody(driverPage, 'loadDriverPage');
    expect(driverPage).toMatch(/\bcomputeDriverCareer\s*\(/);
    // One driver's seasons only, its own incidents only, and no awards history on the main fragment.
    expect(callsOf(driverPage, ['computeDriverCareerStats', 'getAllIncidents'])).toEqual([]);
    expect(main).toMatch(/\bgetIncidentsForDriver\s*\(/);
    expect(callsOf(main, ['computeSeasonAwardsHistory', 'getManualAwards'])).toEqual([]);
    expect(functionBody(driverPage, 'loadDriverAwards')).toMatch(/\bcomputeSeasonAwardsHistory\s*\(/);
  });

  it('trims the round picker to its own columns, read in the first stage', () => {
    const results = page('results/[subsessionId]/fragment.astro');
    expect(results).toMatch(/\bgetRoundPickerRounds\s*\(/);
    expect(callsOf(results, ['getAllRounds'])).toEqual([]);
    const firstStage = results.slice(
      results.indexOf('await Promise.all(['),
      results.indexOf('if (!loadError && !round)'),
    );
    expect(firstStage).toMatch(/getRoundPickerRounds\(/);
  });
});

// Every fragment route on main and the query parameters it reads; the edge cache keys on these (BR4.3).
const MAIN_FRAGMENTS: Record<string, string[]> = {
  'admin/analytics/fragment.astro': ['range'],
  'admin/drivers/fragment.astro': ['filter'],
  'admin/fragment.astro': [],
  'awards/fragment.astro': [],
  'calendar/fragment.astro': ['season'],
  'champions/fragment.astro': ['class', 'team'],
  'driver-stats/fragment.astro': ['class'],
  'drivers/[id]/fragment.astro': ['hof'],
  'hall-of-fame/fragment.astro': [],
  'home/fragment.astro': [],
  'incidents/fragment.astro': [],
  'interviews/fragment.astro': ['season'],
  'kudos/fragment.astro': ['season'],
  'media/fragment.astro': ['filter', 'layout', 'tab'],
  'news/fragment.astro': ['q', 'season'],
  'results/[subsessionId]/fragment.astro': [
    'category',
    'class',
    'links_error',
    'report',
    'season',
    'session',
  ],
  'results/[subsessionId]/incidents/fragment.astro': [
    'appeal',
    'review',
    'roundpenalty',
    'season',
    'submission',
    'view',
  ],
  'results/[subsessionId]/incidents/submissions/fragment.astro': [],
  'results/[subsessionId]/kudos/fragment.astro': ['kudos'],
  'results/fragment.astro': ['season'],
  'roster/fragment.astro': [],
  'standings/fragment.astro': ['championship', 'class', 'mode', 'round', 'season', 'view'],
  'team-stats/fragment.astro': ['view'],
  'teams/fragment.astro': ['season'],
};

function paramsRead(text: string): string[] {
  const names = [...text.matchAll(/searchParams\.(?:get|has|getAll)\('([a-z_]+)'\)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

describe('fragment URLs and parameters (BR4.3)', () => {
  it('keeps every fragment route and the query parameters it reads; the driver’s awards and kudos cards take none', () => {
    const now: Record<string, string[]> = {};
    const cards = ['drivers/[id]/awards.astro', 'drivers/[id]/kudos.astro'];
    for (const [path, text] of Object.entries(PAGES)) {
      const rel = path.replace('/src/pages/', '');
      if (rel.endsWith('/fragment.astro') || cards.includes(rel)) now[rel] = paramsRead(text);
    }
    expect(now).toEqual({
      ...MAIN_FRAGMENTS,
      'drivers/[id]/awards.astro': [],
      'drivers/[id]/kudos.astro': [],
    });
  });

  it('keys the edge cache of every fragment on the parameters it reads', () => {
    const route = (rel: string) =>
      '/' +
      rel
        .replace(/\.astro$/, '')
        .replace(/\[[^\]]+\]/g, 'x')
        .replace(/\/index$/, '');
    for (const [rel, params] of Object.entries(MAIN_FRAGMENTS)) {
      if (rel.startsWith('admin/')) continue; // never cached: admin responses carry a session
      expect(cacheQueryParams(route(rel)).sort(), rel).toEqual(expect.arrayContaining(params));
    }
  });
});

describe("the driver profile's Kudos fragment (driver-profile-polish FR6.5)", () => {
  const kudos = PAGES['/src/pages/drivers/[id]/kudos.astro'];

  it('is cached like the awards card, under its bare path, and never for an unknown id', () => {
    expect(kudos).toContain(
      "Astro.response.headers.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');",
    );
    expect(kudos).toContain(
      "return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });",
    );
    expect(code(kudos)).toMatch(/markUncacheable\(Astro\)/);
    expect(cacheKeyUrl(new URL('https://atc.example/drivers/abc/kudos?x=1'))).toBe(
      'https://atc.example/drivers/abc/kudos',
    );
  });

  it('is loaded by the shell into a placeholder the shell renders, so the shell reads nothing more', () => {
    const shell = page('drivers/[id].astro');
    expect(shell).toContain('data-driver-kudos={`/drivers/${driverId}/kudos`}');
    expect(shell).toMatch(/querySelector<HTMLElement>\('\[data-driver-kudos\]'\)/);
    expect(shell).toMatch(/void loadFragment\(corner,/);
    expect(shell).not.toMatch(/getKudosInvolvingDriver|loadDriverKudos/);
  });
});

describe("the driver profile's Awards fragment", () => {
  const awards = PAGES['/src/pages/drivers/[id]/awards.astro'];

  it('sends the longer cache header and is cached under its bare path', () => {
    expect(awards).toContain(
      "Astro.response.headers.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');",
    );
    expect(code(awards)).toMatch(/markUncacheable\(Astro\)/);
    expect(cacheQueryParams('/drivers/abc/awards')).toEqual([]);
    expect(cacheKeyUrl(new URL('https://atc.example/drivers/abc/awards?x=1&hof=1'))).toBe(
      'https://atc.example/drivers/abc/awards',
    );
  });

  it('is loaded by the shell into the placeholder the main fragment renders', () => {
    const shell = page('drivers/[id].astro');
    expect(shell).toMatch(/bindFragment\('\[data-driver-awards\]'/);
    expect(page('drivers/[id]/fragment.astro')).toMatch(
      /data-driver-awards data-fragment-url=\{`\/drivers\/\$\{driverId\}\/awards`\}/,
    );
  });
});
