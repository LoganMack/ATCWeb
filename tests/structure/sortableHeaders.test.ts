/**
 * Sortable headers never wrap (FR2.1-FR2.3; BR2.1, BR2.2): the site-wide no-wrap rule for `th[data-sort-key]`
 * sits in src/styles/global.css outside any media query, and no sortable header in src/ opts back into
 * wrapping.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const MARKUP = import.meta.glob('/src/**/*.astro', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Vitest empties .css imports, even with ?raw, so the stylesheet is read from disk (as in searchInputs.test.ts).
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const WRAPPING_CLASSES = [
  'whitespace-normal',
  'whitespace-pre-wrap',
  'whitespace-pre-line',
  'break-words',
  'break-all',
];

/** The CSS without comments, so braces or rules quoted in a comment never count. */
function cssCode(): string {
  return GLOBAL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** How many blocks are open at `index`: 0 means top level, not inside @media or any other block. */
function depthAt(css: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
  }
  return depth;
}

/** Every opening tag carrying data-sort-key, with its file. Attribute values may hold `>` only in `{...}`. */
function sortableTags(): { file: string; tag: string }[] {
  return Object.entries(MARKUP).flatMap(([file, text]) =>
    [...text.matchAll(/<[a-zA-Z][\w-]*\b(?:[^>{]|\{[^}]*\})*>/g)]
      .map((m) => m[0])
      .filter((tag) => /\bdata-sort-key\b/.test(tag))
      .map((tag) => ({ file, tag })),
  );
}

describe('sortable headers never wrap (BR2.1, BR2.2)', () => {
  it('keeps one no-wrap rule for th[data-sort-key] at the top level of global.css', () => {
    const css = cssCode();
    const rules = [...css.matchAll(/th\[data-sort-key\]\s*\{([^}]*)\}/g)];
    const noWrap = rules.filter((m) => /white-space:\s*nowrap\s*;?/.test(m[1]));
    expect(noWrap).toHaveLength(1);
    expect(depthAt(css, noWrap[0].index!)).toBe(0);
  });

  it('finds the sortable headers it guards', () => {
    expect(sortableTags().length).toBeGreaterThan(50);
  });

  it('never gives a sortable header a class that lets it wrap', () => {
    const problems = sortableTags().flatMap(({ file, tag }) =>
      WRAPPING_CLASSES.filter((cls) => new RegExp(`(^|[\\s"'\`{:])${cls}($|[\\s"'\`}])`).test(tag)).map(
        (cls) => `${file}: ${cls}`,
      ),
    );
    expect(problems).toEqual([]);
  });
});
