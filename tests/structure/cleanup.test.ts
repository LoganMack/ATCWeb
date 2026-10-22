/**
 * Dead code and clutter stay gone (FR9.1–FR9.4): the removed files and admin redirect routes, the
 * links to them, the middleware exception for /admin/login, the champions back-links, the mockups
 * under design/, the tsconfig include, and the module maps.
 */
import { describe, expect, it } from 'vitest';

// Bundled by Vite's glob import, so the test needs no Node file-system access. A lazy glob is only
// used for its keys, which list the files that exist.
const REMOVED = import.meta.glob([
  '/src/components/ReportIncidentButton.astro',
  '/src/components/StandingsTabs.astro',
  '/src/scripts/logoContrast.ts',
  '/public/*-import-template.csv',
  '/src/pages/admin/login.astro',
  '/src/pages/admin/car-logos/**',
  '/src/pages/admin/champions/index.astro',
  '/src/pages/admin/page-banners/**',
  '/src/pages/admin/penalty-offenses/**',
  '/src/pages/admin/site-settings/**',
]);
const SOURCE = import.meta.glob(['/src/**/*.{astro,ts,js,mjs}', '/scripts/**/*.mjs'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// development-log.md is the project history, so it keeps naming what used to exist.
const DOCS = import.meta.glob(['/README.md', '/docs/**/*.md', '!/docs/development-log.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const ROOT_MOCKUPS = import.meta.glob(['/*.html', '/*.png']);
const DESIGN = import.meta.glob('/design/*');
const SRC_FILES = import.meta.glob('/src/**/*');
const MAPS = import.meta.glob('/scripts/module-maps/*.json', { import: 'default', eager: true }) as Record<
  string,
  { original: string; originalDeleted?: boolean } & Record<string, unknown>
>;
const TSCONFIG = import.meta.glob('/tsconfig.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const MOCKUPS = [
  'banner-texture-options-2.html',
  'banner-texture-options.html',
  'calendar-map-styles.png',
  'filter-card-options.html',
  'mic-icon-options.html',
  'opaque-preview.html',
  'slider-and-banner-options.html',
];

const CHAMPIONS_TAB = '/admin/site-properties?tab=champions';

// A removed route or file used as a link: inside a string literal in code, anywhere in the docs.
// /admin/champions/<season>/<class> and /admin/champions/hall-of-fame/<driver> still exist.
const REMOVED_ROUTE = String.raw`/admin/(?:login|car-logos|page-banners|penalty-offenses|site-settings|champions(?!/))(?![\w-])`;
const REMOVED_FILE = String.raw`(?:ReportIncidentButton|StandingsTabs|logoContrast|(?:circuits|events|news)-import-template\.csv)`;
const IN_CODE = new RegExp(String.raw`['"\`](?:[^'"\`\n]*?)(?:${REMOVED_ROUTE}|${REMOVED_FILE})`);
const IN_DOCS = new RegExp(`${REMOVED_ROUTE}|${REMOVED_FILE}`);

function linksToRemoved(files: Record<string, string>, pattern: RegExp): string[] {
  return Object.entries(files).flatMap(([path, text]) =>
    text
      .split(/\r?\n/)
      .map((line, i) => (pattern.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
      .filter((hit): hit is string => hit !== null),
  );
}

// tsconfig include patterns must start at a named source folder or file, so none can reach design/,
// aidlc/, .claude/ or any other folder added later.
const NOT_TYPE_CHECKED = ['design', 'aidlc', '.claude'];
function reachesOutsideSource(pattern: string): boolean {
  const first = pattern.split('/')[0];
  return /[*?{[]/.test(first) || NOT_TYPE_CHECKED.includes(first);
}

/** Every src/ path a module map names, except a deleted original, that is not in the tree. */
function missingMapPaths(
  map: { original: string; originalDeleted?: boolean } & Record<string, unknown>,
  srcFiles: string[],
): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('src/')) paths.add(value);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  for (const [key, value] of Object.entries(map)) {
    if (key === 'original' && map.originalDeleted !== false) continue;
    walk(value);
  }
  const exists = (p: string) => srcFiles.some((f) => f === `/${p}` || f.startsWith(`/${p}/`));
  return [...paths].filter((p) => !exists(p));
}

describe('cleanup: dead code and clutter (FR9)', () => {
  it('removes the dead components, script, CSV templates and admin redirect routes (FR9.1, FR9.2)', () => {
    expect(Object.keys(REMOVED)).toEqual([]);
    // The two champions photo pages and the public team-standings redirect stay.
    expect(Object.keys(SOURCE)).toContain('/src/pages/admin/champions/[seasonId]/[classId].astro');
    expect(Object.keys(SOURCE)).toContain('/src/pages/admin/champions/hall-of-fame/[driverId].astro');
    expect(Object.keys(SOURCE).some((p) => p.startsWith('/src/pages/team-standings'))).toBe(true);
  });

  it('leaves no link to a removed route or file in the source or the docs', () => {
    expect(Object.keys(SOURCE).length).toBeGreaterThan(100);
    expect(linksToRemoved(SOURCE, IN_CODE)).toEqual([]);
    expect(linksToRemoved(DOCS, IN_DOCS)).toEqual([]);
  });

  it('gates every /admin path, with no public exception for /admin/login (FR9.2b)', () => {
    const middleware = SOURCE['/src/middleware.ts'];
    expect(middleware).toBeDefined();
    expect(middleware).not.toContain('/admin/login');
    expect(middleware).not.toContain('PUBLIC_ADMIN_PATHS');
    expect(middleware).toContain('/login?next=');
  });

  it('sends the champions photo pages back to the Site Properties champions tab (FR9.2a)', () => {
    const tabs = SOURCE['/src/pages/admin/site-properties/index.astro'];
    expect(tabs).toContain("key: 'champions'");
    for (const page of [
      '/src/pages/admin/champions/[seasonId]/[classId].astro',
      '/src/pages/admin/champions/hall-of-fame/[driverId].astro',
    ]) {
      const text = SOURCE[page];
      expect(text, page).toContain(`Astro.redirect('${CHAMPIONS_TAB}', 302)`);
      expect(text, page).toContain(`href="${CHAMPIONS_TAB}"`);
      expect(text, page).not.toMatch(/['"]\/admin\/champions['"]/);
    }
  });

  it('keeps the design mockups under design/, not at the repository root (FR9.3)', () => {
    expect(Object.keys(ROOT_MOCKUPS)).toEqual([]);
    const design = Object.keys(DESIGN).map((p) => p.replace('/design/', ''));
    expect(design).toEqual(expect.arrayContaining(MOCKUPS));
  });

  it('type-checks only source folders: design/, aidlc/ and .claude/ are outside the include (FR9.4)', () => {
    const tsconfig = JSON.parse(TSCONFIG['/tsconfig.json']) as { include: string[]; exclude?: string[] };
    expect(tsconfig.include).toContain('src/**/*');
    expect(tsconfig.include).toContain('tests/**/*');
    expect(tsconfig.include.filter(reachesOutsideSource)).toEqual([]);
  });

  it('lists only files that exist in every module map', () => {
    expect(Object.keys(MAPS).length).toBeGreaterThan(0);
    expect(Object.keys(MAPS)).not.toContain('/scripts/module-maps/penalties.json');
    const srcFiles = Object.keys(SRC_FILES);
    for (const [path, map] of Object.entries(MAPS)) {
      expect(missingMapPaths(map, srcFiles), path).toEqual([]);
    }
  });
});

describe('cleanup: the checks themselves', () => {
  it('flags a link to a removed route or file and ignores comments and surviving subpages', () => {
    const files = {
      'a.astro': [
        `<a href="/admin/car-logos">`,
        `return Astro.redirect('/admin/champions', 302);`,
        `import X from '../components/StandingsTabs.astro';`,
        `// formerly /admin/champions, now a tab`,
        'href={`/admin/champions/hall-of-fame/${id}`}',
        `<a href="/admin/site-properties?tab=champions">`,
        `<a href="/admin/login-help">`,
      ].join('\n'),
    };
    expect(linksToRemoved(files, IN_CODE)).toEqual([
      'a.astro:1: <a href="/admin/car-logos">',
      "a.astro:2: return Astro.redirect('/admin/champions', 302);",
      "a.astro:3: import X from '../components/StandingsTabs.astro';",
    ]);
  });

  it('treats wildcard, design/, aidlc/ and .claude/ include patterns as reaching outside source', () => {
    expect(reachesOutsideSource('**/*')).toBe(true);
    expect(reachesOutsideSource('*.ts')).toBe(true);
    expect(reachesOutsideSource('design/**/*')).toBe(true);
    expect(reachesOutsideSource('.claude/**/*')).toBe(true);
    expect(reachesOutsideSource('src/**/*')).toBe(false);
    expect(reachesOutsideSource('astro.config.mjs')).toBe(false);
    const map = {
      original: 'src/lib/gone.ts',
      originalDeleted: true,
      modules: { a: 'src/lib/x.ts', b: 'src/lib/y.ts' },
    };
    expect(missingMapPaths(map, ['/src/lib/x.ts'])).toEqual(['src/lib/y.ts']);
    expect(missingMapPaths({ ...map, originalDeleted: false }, ['/src/lib/x.ts', '/src/lib/y.ts'])).toEqual([
      'src/lib/gone.ts',
    ]);
  });
});
