/**
 * Rulebook rendering (src/lib/rulebookMarkdown.ts): GitHub-flavoured markdown (FR2.2), raw HTML and unsafe
 * links neutralised (FR2.3), unique heading anchors (FR2.4), the contents panel's headings and table labels
 * (FR3.2, FR3.4, FR3.5), and the seeded Rulebook 18.3 read from the migration itself (FR5.2, FR5.4).
 */
import { describe, expect, it } from 'vitest';
import MIGRATION from '../../supabase/migrations/20261104120000_rulebook_versions.sql?raw';
import {
  isSafeRulebookHref,
  renderRulebook,
  renderRulebookVersion,
  slugify,
} from '../../src/lib/rulebookMarkdown';

/** The dollar-quoted seed body, exactly as the migration inserts it. */
const SEED = MIGRATION.split('$rulebook$')[1];

describe('GitHub-flavoured markdown (FR2.2)', () => {
  it('renders tables with alignment, strikethrough, emphasis, quotes, code and rules', () => {
    const { html } = renderRulebook(
      [
        '| Pos | Points |',
        '| :---: | ---: |',
        '| **1** | 200 |',
        '',
        '~~old rule~~ and *new* text with `code`',
        '',
        '> quoted',
        '',
        '---',
        '',
        '```',
        'block',
        '```',
      ].join('\n'),
    );
    expect(html).toContain('<table>');
    expect(html).toMatch(/<th align="center">Pos<\/th>/);
    expect(html).toMatch(/<td align="right">200<\/td>/);
    expect(html).toContain('<strong>1</strong>');
    expect(html).toContain('<del>old rule</del>');
    expect(html).toContain('<em>new</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code>block');
  });

  it('keeps a list that starts at 6 and nested lists', () => {
    const { html } = renderRulebook('6. Six\n7. Seven\n    1. Nested\n');
    expect(html).toContain('<ol start="6">');
    expect(html).toMatch(/<li>Seven<ol>\s*<li>Nested<\/li>/);
  });
});

describe('raw HTML and unsafe links (FR2.3, NFR2)', () => {
  it('shows raw HTML as text, block and inline', () => {
    const { html } = renderRulebook('<script>alert(1)</script>\n\nHello <img src=x onerror=alert(1)> there');
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('turns javascript: and data: links into plain text, keeps http(s), mailto and anchors', () => {
    const { html } = renderRulebook(
      '[bad](javascript:alert(1)) [data](data:text/html,hi) <javascript:alert(2)> [web](https://example.com) [mail](mailto:a@b.test) [jump](#blue-flags) [rel](/standings)',
    );
    expect(html).not.toMatch(/href="(?:javascript|data):/i);
    expect(html).toContain('bad');
    expect(html).toContain('<a href="https://example.com">web</a>');
    expect(html).toContain('<a href="mailto:a@b.test">mail</a>');
    expect(html).toContain('<a href="#blue-flags">jump</a>');
    expect(html).not.toContain('href="/standings"');
    expect(isSafeRulebookHref(' JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeRulebookHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeRulebookHref('#')).toBe(false);
  });

  it('shows an image as its alt text, never as an image', () => {
    const { html } = renderRulebook('![League logo](https://example.com/logo.png "t")');
    expect(html).not.toContain('<img');
    expect(html).toContain('League logo');
  });
});

describe('heading anchors (FR2.4)', () => {
  it('gives each heading a readable id and keeps duplicates unique', () => {
    const { html, headings } = renderRulebook(
      '## Blue Flags\n\n## Blue Flags\n\n### Driver’s *Championship*\n',
    );
    expect(headings.map((h) => h.id)).toEqual(['blue-flags', 'blue-flags-2', 'drivers-championship']);
    expect(headings.map((h) => h.text)).toEqual(['Blue Flags', 'Blue Flags', 'Driver’s Championship']);
    expect(headings.map((h) => h.level)).toEqual([2, 2, 3]);
    expect(html).toContain('<h2 id="blue-flags" tabindex="-1">Blue Flags</h2>');
    expect(html).toContain('<h2 id="blue-flags-2" tabindex="-1">');
    expect(slugify('6. Racing Guidelines')).toBe('6-racing-guidelines');
    expect(slugify('Rejoins & Lost Control')).toBe('rejoins-lost-control');
  });

  it('falls back to "section" for a heading with no letters or digits', () => {
    expect(renderRulebook('## ***\n\n## ---!').headings.map((h) => h.id)).toEqual(['section', 'section-2']);
  });
});

describe('the contents panel (FR3.2, FR3.4, FR3.5)', () => {
  it('leaves "Table:" headings out of the heading list', () => {
    const { headings } = renderRulebook('## Scoring\n\n### Table: Points System\n\n| a |\n| - |\n| 1 |\n');
    expect(headings.map((h) => h.text)).toEqual(['Scoring']);
  });

  it('labels each table from the heading just above it, else by its position', () => {
    const { tables, html } = renderRulebook(
      [
        '### Table: Points System',
        '',
        '| a |',
        '| - |',
        '| 1 |',
        '',
        'Some text.',
        '',
        '| b |',
        '| - |',
        '| 2 |',
        '',
        '### Penalties',
        '',
        '| c |',
        '| - |',
        '| 3 |',
      ].join('\n'),
    );
    expect(tables).toEqual([
      { id: 'table-1', label: 'Points System' },
      { id: 'table-2', label: 'Table 2' },
      { id: 'table-3', label: 'Penalties' },
    ]);
    expect(html).toContain(
      '<div class="rulebook-table" id="table-1" role="region" aria-label="Points System" tabindex="0"><table>',
    );
  });

  it('returns no tables when there are none', () => {
    expect(renderRulebook('## Only text\n\nNo tables here.').tables).toEqual([]);
  });
});

describe('the seeded Rulebook 18.3 (FR5.2, FR5.4)', () => {
  const rendered = renderRulebook(SEED);

  it('has all five tables, labelled from their headings', () => {
    expect(rendered.tables.map((t) => t.label)).toEqual([
      'Points System',
      'Class Points',
      'Bonus Points',
      'Post-Race Penalties',
      'PP Penalties',
    ]);
  });

  it('keeps the section numbers and the rule numbers that cross-references use', () => {
    const sections = rendered.headings.filter((h) => h.level === 2).map((h) => h.text);
    expect(sections).toEqual([
      '1. Community Guidelines',
      '2. Driver’s Championship',
      '3. Team Championship',
      '4. Race Day Format',
      '5. Stewarding',
      '6. Racing Guidelines',
    ]);
    // "(see 6.15)": section 6's Blue Flags list starts at 15.
    expect(rendered.html).toMatch(/<h3 id="blue-flags" tabindex="-1">Blue Flags<\/h3>\s*<ol start="15">/);
    expect(rendered.headings.some((h) => h.text.startsWith('Table:'))).toBe(false);
  });

  it('memoises the render by version id', () => {
    const first = renderRulebookVersion({ id: 1, body_md: SEED });
    expect(renderRulebookVersion({ id: 1, body_md: 'ignored for the same id' })).toBe(first);
    expect(renderRulebookVersion({ id: 2, body_md: '## Other' }).headings[0].text).toBe('Other');
  });
});
