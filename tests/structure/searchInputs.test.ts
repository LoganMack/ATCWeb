/**
 * Search box width (FR7.1-FR7.3): every `<input type="search">` under src/ takes its width from the one shared
 * `.search-input` class in src/styles/global.css (40 characters, shrinking to fit), with none of the old
 * per-file width utilities left on it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const MARKUP = raw(import.meta.glob('/src/**/*.astro', { query: '?raw', import: 'default', eager: true }));

// Vitest empties .css imports, even with ?raw, so the stylesheet is read from disk (as in frontEnd.test.ts).
let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

const OLD_WIDTHS = ['min-w-[14rem]', 'w-full', 'flex-1', 'sm:max-w-sm', 'max-w-sm'];

/** Every search input's opening tag, with the file it is in. Attribute values may hold `>` only in `{...}`. */
function searchInputs(): { file: string; tag: string }[] {
  return Object.entries(MARKUP).flatMap(([file, text]) =>
    [...text.matchAll(/<input\b(?:[^>{]|\{[^}]*\})*>/g)]
      .map((m) => m[0])
      .filter((tag) => /\btype="search"/.test(tag))
      .map((tag) => ({ file, tag })),
  );
}

/** The class attribute's text: a plain string, or the rest of the tag after `class={` (it may nest braces). */
function classText(tag: string): string {
  const plain = /\bclass="([^"]*)"/.exec(tag);
  if (plain) return plain[1];
  const at = tag.indexOf('class={');
  return at < 0 ? '' : tag.slice(at + 'class={'.length);
}

describe('search inputs (FR7)', () => {
  it('finds all 14 search boxes', () => {
    expect(searchInputs().length).toBeGreaterThanOrEqual(14);
  });

  it('gives every search box the shared .search-input class and no old width utility', () => {
    const problems = searchInputs().flatMap(({ file, tag }) => {
      const cls = classText(tag);
      const words = cls.split(/[\s`${}]+/);
      const issues: string[] = [];
      if (!words.includes('search-input')) issues.push(`${file}: no search-input class`);
      for (const old of OLD_WIDTHS) if (words.includes(old)) issues.push(`${file}: still has ${old}`);
      return issues;
    });
    expect(problems).toEqual([]);
  });

  it('defines the width once: 40ch, never wider than its container, not stretched or squeezed by flex', () => {
    const rules = [...GLOBAL_CSS.matchAll(/\.search-input\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/width:\s*40ch;/);
    expect(rules[0]).toMatch(/max-width:\s*100%;/);
    expect(rules[0]).toMatch(/flex:\s*none;/);
    // One shared style: no search box sets its own ch width.
    expect(searchInputs().filter(({ tag }) => /\bw-\[\d+ch\]/.test(tag))).toEqual([]);
  });
});
