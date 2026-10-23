/**
 * Front-end loading (U5: FR4, FR7, FR8): the layout loads only the site-wide scripts and each page imports
 * the feature scripts whose hooks it renders; the five shells preload their own fragment URL; fonts are
 * self-hosted; and no POST form opts back into the client router.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import HEADERS from '../../public/_headers?raw';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const ASTRO = raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }));
const SRC = raw(
  import.meta.glob('/src/**/*.{astro,ts,js,mjs,css}', { query: '?raw', import: 'default', eager: true }),
);
// A lazy glob is only used for its keys, which list the font files that exist.
const FONT_FILES = Object.keys(import.meta.glob('/public/fonts/*.woff2'));

const LAYOUT = ASTRO['/src/layouts/Layout.astro'];
// Vitest empties .css imports, even with ?raw, so the stylesheet is read from disk. The specifier is typed as
// a plain string because the project has no Node type definitions.
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const SITE_WIDE = [
  'pageProgress',
  'reveal',
  'hard-form-submit',
  'sortable-table',
  'expandRows',
  'theme',
  'delegatedControls',
];

const P = '/src/pages/';
/** Each moved script, the hook attributes it acts on, and the pages that must import it. */
const SCRIPT_MAP: Record<string, { hooks: string[]; shells: string[] }> = {
  localTime: {
    hooks: ['data-utc-time'],
    shells: ['briefing/[eventId].astro', 'index.astro', 'calendar.astro'],
  },
  circuitLayoutDetail: { hooks: ['data-layout-detail-body'], shells: ['circuits.astro'] },
  hofClassFilter: { hooks: ['data-hof-card'], shells: ['hall-of-fame.astro'] },
  addToCalendar: {
    hooks: ['data-ics-event', 'data-ics-download'],
    shells: ['calendar.astro', 'index.astro'],
  },
  lightbox: {
    hooks: ['data-lightbox'],
    shells: [
      'media.astro',
      'admin/champions/hall-of-fame/[driverId].astro',
      'admin/champions/[seasonId]/[classId].astro',
      'hall-of-fame.astro',
      'champions.astro',
    ],
  },
  tableCsvExport: { hooks: ['data-csv-export'], shells: ['standings.astro'] },
  driverPickerSearch: {
    hooks: ['data-driver-picker'],
    shells: [
      'results/[subsessionId]/incidents.astro',
      'results/[subsessionId].astro',
      'results/[subsessionId]/kudos.astro',
    ],
  },
  logoSelect: {
    hooks: ['data-logo-select'],
    shells: [
      'calendar.astro',
      'news/index.astro',
      'results.astro',
      'standings.astro',
      'teams.astro',
      'admin/awards/index.astro',
      'admin/events/index.astro',
      'admin/events/[id].astro',
      'admin/teams/[id].astro',
    ],
  },
};

const PRELOAD_SHELLS = [
  'index.astro',
  'standings.astro',
  'results/[subsessionId].astro',
  'results/[subsessionId]/incidents.astro',
  'drivers/[id].astro',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the file's markup carries the attribute (not a `[data-x]` selector in a script). */
function rendersHook(text: string, hook: string): boolean {
  return new RegExp(`\\b${escapeRe(hook)}(?=[\\s=>/])`).test(text);
}

/** Files that import the component at `path` (matched by its exact file name). */
function importersOf(path: string): string[] {
  const name = path.split('/').pop()!;
  const re = new RegExp(`from ['"][^'"]*/${escapeRe(name)}['"]`);
  return Object.keys(ASTRO).filter((file) => file !== path && re.test(ASTRO[file]));
}

/** The shell that loads a fragment route, found by its route string in a `data-fragment-url` page. */
function shellOf(fragment: string): string | undefined {
  const route = fragment
    .replace(/^\/src\/pages/, '')
    .replace(/\.astro$/, '')
    .split(/(\[[^\]]+\])/)
    .map((part) => (/^\[.+\]$/.test(part) ? '\\$\\{[^}]+\\}' : escapeRe(part)))
    .join('');
  const re = new RegExp(`['"\`]${route}(?:['"\`?]|\\$\\{)`);
  return Object.keys(ASTRO).find(
    (file) =>
      file.startsWith(P) &&
      !file.endsWith('/fragment.astro') &&
      /data-fragment-url/.test(ASTRO[file]) &&
      re.test(ASTRO[file]),
  );
}

/** Pages that must import a script for `hooks`: renderers, through components, up to fragment shells. */
function requiredShells(hooks: string[]): string[] {
  const pending = Object.keys(ASTRO).filter((file) => hooks.some((hook) => rendersHook(ASTRO[file], hook)));
  const seen = new Set<string>();
  const shells = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(P)) pending.push(...importersOf(file));
    else if (file.endsWith('/fragment.astro')) shells.add(shellOf(file) ?? `no shell for ${file}`);
    else shells.add(file);
  }
  return [...shells].sort();
}

function importsScript(text: string, script: string): boolean {
  return new RegExp(`import ['"](?:\\.\\./)+scripts/${escapeRe(script)}['"]`).test(text);
}

describe('front-end loading (U5)', () => {
  it('loads exactly the 7 site-wide scripts from Layout.astro (BR2.1)', () => {
    const loaded = [...LAYOUT.matchAll(/<script src="\.\.\/scripts\/([\w-]+)\.ts"><\/script>/g)].map(
      (m) => m[1],
    );
    expect(loaded.sort()).toEqual([...SITE_WIDE].sort());
    for (const script of Object.keys(SCRIPT_MAP)) expect(LAYOUT, script).not.toContain(`scripts/${script}`);
  });

  it('imports each moved script in exactly the pages that render its hook (BR2.2)', () => {
    for (const [script, { hooks, shells }] of Object.entries(SCRIPT_MAP)) {
      const expected = shells.map((s) => P + s).sort();
      expect(requiredShells(hooks), `${script}: pages rendering ${hooks.join(', ')}`).toEqual(expected);
      const importers = Object.keys(SRC).filter((file) => importsScript(SRC[file], script));
      expect(importers.sort(), `${script}: importers`).toEqual(expected);
    }
    // The walk follows components into fragments: PhotoGrid reaches champions.astro through ChampionCard.
    expect(requiredShells(['data-lightbox'])).toContain(`${P}champions.astro`);
  });

  it('preloads each shell fragment with the same string the loader fetches (BR1.1, BR1.3)', () => {
    expect(LAYOUT).toMatch(
      /\{preloadFragment && <link rel="preload" as="fetch" crossorigin="anonymous" href=\{preloadFragment\} \/>\}/,
    );
    for (const shell of PRELOAD_SHELLS) {
      const text = ASTRO[P + shell];
      expect(text, shell).toMatch(/\nconst fragmentUrl =/);
      expect(text, shell).toMatch(/<Layout\b[^>]*\spreloadFragment=\{fragmentUrl\}/);
      expect(text, shell).toMatch(/data-fragment-url=\{fragmentUrl\}/);
      expect(text.match(/data-fragment-url=/g), shell).toHaveLength(1);
    }
    const preloading = Object.keys(ASTRO).filter((f) => /\spreloadFragment=/.test(ASTRO[f]));
    expect(preloading.sort()).toEqual(PRELOAD_SHELLS.map((s) => P + s).sort());
  });

  it('requests nothing from Google Fonts and preloads two self-hosted fonts (BR3.2, BR3.3)', () => {
    const hits = Object.keys(SRC).filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(SRC[f]));
    expect(hits).toEqual([]);
    const preloads = [...LAYOUT.matchAll(/<link\s+rel="preload"\s+as="font"([^>]*)\/>/g)].map((m) => m[1]);
    expect(preloads).toHaveLength(2);
    for (const attrs of preloads) {
      expect(attrs).toMatch(/\stype="font\/woff2"\s+crossorigin\s+href="\/fonts\//);
      // Kept across client-side navigations, so the router never re-adds a preload the page has already used.
      expect(attrs).toMatch(/\sdata-astro-transition-persist="font-preload-\w+"/);
    }
    const hrefs = preloads.map((attrs) => /href="([^"]+)"/.exec(attrs)![1]);
    expect(hrefs).toEqual(['/fonts/teko-latin-v1.woff2', '/fonts/roboto-latin-v1.woff2']);
    for (const href of hrefs) expect(FONT_FILES).toContain(`/public${href}`);
  });

  it('declares every weight with font-display: swap from files that exist (BR3.1)', () => {
    const faces = [...GLOBAL_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const declared = new Set<string>();
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap;/);
      expect(face).toMatch(/unicode-range:\s*U\+/);
      const family = /font-family:\s*'(\w+)'/.exec(face)![1];
      const weight = /font-weight:\s*(\d+)/.exec(face)![1];
      const url = /src:\s*url\('([^']+)'\) format\('woff2'\)/.exec(face)![1];
      expect(FONT_FILES, url).toContain(`/public${url}`);
      declared.add(`${family} ${weight} ${url.includes('-latin-ext-') ? 'latin-ext' : 'latin'}`);
    }
    const expected = [
      ...['400', '500', '600', '700'].map((w) => `Teko ${w}`),
      ...['400', '500', '700'].map((w) => `Roboto ${w}`),
    ].flatMap((fw) => [`${fw} latin`, `${fw} latin-ext`]);
    expect([...declared].sort()).toEqual(expected.sort());
    expect(faces).toHaveLength(expected.length);
  });

  it('caches /fonts/* for a year as immutable (BR3.1)', () => {
    const block = /^\/fonts\/\*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(HEADERS);
    expect(block).not.toBeNull();
    const cache = /Cache-Control:\s*(.+)/.exec(block![1])![1];
    expect(cache).toMatch(/\bpublic\b/);
    expect(cache).toMatch(/\bimmutable\b/);
    expect(Number(/max-age=(\d+)/.exec(cache)![1])).toBeGreaterThanOrEqual(31536000);
  });

  it('lets no POST form opt back into the client router (BR5.1)', () => {
    const optIns = Object.entries(SRC).flatMap(([path, text]) =>
      [
        ...text.matchAll(
          /data-astro-reload=(?:["']false["']|\{false\})|removeAttribute\(['"]data-astro-reload['"]\)/g,
        ),
      ].map((m) => `${path}: ${m[0]}`),
    );
    expect(optIns).toEqual([]);
    expect(SRC['/src/scripts/hard-form-submit.ts']).toMatch(/form\.dataset\.astroReload = '';/);
    expect(SRC['/src/scripts/hard-form-submit.ts']).not.toMatch(/fetch\(/);
  });
});
