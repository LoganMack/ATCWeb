/**
 * Docs and comments stay current (FR10.1–FR10.4): the README's Node version, references to docs that
 * exist, no comment naming a deleted module or table, short comments in src/, and the history that moved
 * out of the comments into docs/development-log.md. The comments-only proof for a change runs from the
 * command line against its base commit: node scripts/comments.mjs --compare <base> <file>...
 */
import { describe, expect, it } from 'vitest';
import { commentBlocks, firstDifference, stripComments } from '../../scripts/comments.mjs';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const SRC = raw(
  import.meta.glob('/src/**/*.{astro,ts,js,mjs,css}', { query: '?raw', import: 'default', eager: true }),
);
const SCRIPTS = raw(
  import.meta.glob('/scripts/**/*.{mjs,ts}', { query: '?raw', import: 'default', eager: true }),
);
const DOCS = raw(
  import.meta.glob(['/README.md', '/docs/**/*.md'], { query: '?raw', import: 'default', eager: true }),
);
// Every Markdown file in the repository; the keys say which docs exist.
const MARKDOWN = Object.keys(import.meta.glob(['/**/*.md', '!/node_modules/**', '!/dist/**']));
const PACKAGE = import.meta.glob('/package.json', { import: 'default', eager: true }) as Record<
  string,
  { engines: { node: string } }
>;

const README = DOCS['/README.md'];
const DEV_LOG = DOCS['/docs/development-log.md'];

// Docs that were referenced but never existed in this repository.
const MISSING_DOCS = ['PERFORMANCE_AUDIT', 'HANDOFF'];

// Split or retired modules and dropped database objects. The `(?<![\w/])` keeps src/lib/db/penalties.ts
// (which exists) from matching the deleted src/lib/penalties.ts.
const DELETED_MODULES = String.raw`(?:src/lib/|(?<![\w/]))(?:results|supabase|penalties)\.ts\b|penalties/(?:points|reorder|roundResults|seasonAdjustments)\b`;
const DELETED_IN_SRC = new RegExp(
  String.raw`${DELETED_MODULES}|\brace_scores(?:_public)?\b|\brecalculate_race_scores\b|\breorderByTimePenalty\b|\bapplyPenaltiesToRoundResults\b|\bcomputeSeasonClassAdjustments\b`,
);
const DELETED_IN_SCRIPTS = new RegExp(DELETED_MODULES);

// Comment blocks allowed past the length limit, with the reason each may stay long.
const MAX_COMMENT_LINES = 8;
const LONG_COMMENT_ALLOWLIST: Record<string, string> = {
  '/src/scripts/vendor/': 'third-party code (imagetracer), vendored as published',
};

// The areas the history from the code comments was moved under.
const DEV_LOG_AREAS = [
  'Results and standings',
  'Penalties and incidents',
  'Drivers and roster',
  'Teams',
  'Calendar, events and circuits',
  'News and media',
  'Homepage and page loading',
  'Navigation and layout',
  'Client scripts and forms',
  'Data access and auth',
  'Admin',
];

function matchingLines(files: Record<string, string>, pattern: RegExp): string[] {
  return Object.entries(files).flatMap(([path, text]) =>
    text
      .split(/\r?\n/)
      .map((line, i) => (pattern.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
      .filter((hit): hit is string => hit !== null),
  );
}

describe('docs and comments (FR10)', () => {
  it('states the Node version package.json engines requires (FR10.1)', () => {
    const engines = Object.values(PACKAGE)[0].engines.node;
    const major = /^>=\s*(\d+)/.exec(engines)?.[1];
    expect(major, engines).toBeDefined();
    expect(README).toContain(`Node.js ${major} or newer`);
    expect(README).not.toMatch(/Node\.js (?!\d+ or newer \(`engines`)/);
  });

  it('references no doc that does not exist (FR10.2)', () => {
    const files = { ...SRC, ...SCRIPTS, ...DOCS };
    expect(matchingLines(files, new RegExp(MISSING_DOCS.join('|')))).toEqual([]);
    // Every path-like Markdown reference (it names a folder) resolves to a file in the repository.
    const unresolved = Object.entries(files).flatMap(([path, text]) =>
      [...text.matchAll(/(?:\.\.\/)?\b[\w-]+(?:\/[\w.-]+)*\/[\w.-]+\.md\b/g)]
        .map((m) => m[0])
        .filter((ref) => !MARKDOWN.some((md) => md.endsWith(`/${ref.replace(/^(?:\.\.\/)+/, '')}`)))
        .map((ref) => `${path}: ${ref}`),
    );
    expect(unresolved).toEqual([]);
  });

  it('names no deleted module or dropped table, and cites the self-service migration where it lives', () => {
    expect(Object.keys(SRC).length).toBeGreaterThan(200);
    expect(matchingLines(SRC, DELETED_IN_SRC)).toEqual([]);
    expect(matchingLines(SCRIPTS, DELETED_IN_SCRIPTS)).toEqual([]);
    // FR10.3: the driver profile cites the migration that added self-service editing, at its archived path.
    expect(SRC['/src/pages/drivers/[id].astro']).toContain(
      'supabase/migrations/archive/0105_driver_self_service_profile.sql',
    );
    expect(MARKDOWN.length).toBeGreaterThan(0);
  });

  it(`keeps every comment block in src/ to ${MAX_COMMENT_LINES} lines, outside the allowlist (FR10.4)`, () => {
    const allowed = (path: string) =>
      Object.keys(LONG_COMMENT_ALLOWLIST).some((prefix) => path.startsWith(prefix));
    const long = Object.entries(SRC)
      .filter(([path]) => !allowed(path))
      .flatMap(([path, text]) =>
        commentBlocks(path, text)
          .filter((b) => b.lines > MAX_COMMENT_LINES)
          .map((b) => `${path}:${b.startLine} (${b.lines} lines)`),
      );
    expect(long).toEqual([]);
    for (const [prefix, reason] of Object.entries(LONG_COMMENT_ALLOWLIST)) {
      expect(reason.length, prefix).toBeGreaterThan(10);
      expect(
        Object.keys(SRC).some((path) => path.startsWith(prefix)),
        `${prefix} still exists`,
      ).toBe(true);
    }
  });

  it('keeps the moved history in docs/development-log.md, one dated section per area (FR10.4)', () => {
    expect(DEV_LOG).toContain('# History moved out of code comments');
    const history = DEV_LOG.slice(DEV_LOG.indexOf('# History moved out of code comments'));
    const headings = [...history.matchAll(/^## (\d{4}-\d{2}-\d{2}): (.+)$/gm)].map((m) => m[2].trim());
    expect(headings).toEqual(DEV_LOG_AREAS);
    // Each bullet names the source file its comment came from, and that file exists.
    const bullets = history.split(/\r?\n/).filter((line) => line.startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(DEV_LOG_AREAS.length);
    const sources = bullets.map((line) => /\(`([^`]+)`\)$/.exec(line)?.[1] ?? `no source: ${line}`);
    expect(sources.filter((file) => !SRC[`/${file}`])).toEqual([]);
  });

  it('strips comments, and only comments, from code and Astro samples', () => {
    const ts = `/** Doc. */\nexport const a = 1; // trailing\n/* block */ const s = '// not a comment';\nconst t = \`/* nor */\`;\n`;
    const tsTrimmed = `export const a = 1;\nconst s = '// not a comment'; // why\nconst t = \`/* nor */\`;\n`;
    expect(firstDifference(stripComments('a.ts', ts), stripComments('a.ts', tsTrimmed))).toBeNull();
    expect(stripComments('a.ts', ts)).toContain("code:'// not a comment'");
    expect(
      firstDifference(stripComments('a.ts', ts), stripComments('a.ts', ts.replace('= 1', '= 2'))),
    ).not.toBeNull();

    const astro = [
      '---',
      '// frontmatter note',
      'const x = 1;',
      '---',
      '<!-- markup note -->',
      '<p>{/* expression note */}{x}</p>',
      '{list.map((i) => (',
      '  // markup line note',
      '  <a href="https://example.com">{i}</a>',
      '))}',
      '<script>',
      '  /* script note */ init();',
      '</script>',
      '<style>/* style note */ p { color: red; }</style>',
    ].join('\n');
    // Markup is compared as whitespace-separated words, so a removed comment leaves a space behind.
    const bare = astro.replace(
      /\/\/ (frontmatter|markup line) note|<!-- markup note -->|\{\/\* expression note \*\/\}|\/\* (script|style) note \*\//g,
      ' ',
    );
    expect(firstDifference(stripComments('p.astro', astro), stripComments('p.astro', bare))).toBeNull();
    expect(stripComments('p.astro', astro)).toContain('markup:href="https://example.com">{i}</a>');
    expect(
      firstDifference(
        stripComments('p.astro', astro),
        stripComments('p.astro', astro.replace('red', 'blue')),
      ),
    ).not.toBeNull();
  });

  it('counts a run of // lines as one block and separate comments as separate blocks', () => {
    const text = ['// one', '// two', '// three', 'const a = 1;', '', '/*', ' * four', ' */', '// five'].join(
      '\n',
    );
    expect(commentBlocks('b.ts', text).map((b) => [b.startLine, b.lines])).toEqual([
      [1, 3],
      [6, 3],
      [9, 1],
    ]);
    const css = '/* a\n   b */\np { color: red; }\n';
    expect(commentBlocks('s.css', css).map((b) => b.lines)).toEqual([2]);
  });
});
