/**
 * CODEOWNERS names the owner for the whole repository (FR7.3).
 */
import { describe, expect, it } from 'vitest';
// A direct import, because import.meta.glob skips dot-folders such as .github.
import CODEOWNERS from '../../.github/CODEOWNERS?raw';

/** Non-comment lines as [pattern, ...owners]. */
function rules(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/));
}

describe('CODEOWNERS', () => {
  it('exists under .github/ and is not empty', () => {
    expect(CODEOWNERS.trim().length).toBeGreaterThan(0);
  });

  it('gives every path to the owner and nothing narrower overrides it', () => {
    const parsed = rules(CODEOWNERS);
    expect(parsed).toEqual([['*', '@LoganMack']]);
  });

  it('parses owners and skips comments', () => {
    expect(rules('# note\n\n* @a @b\r\n/docs/ @c')).toEqual([
      ['*', '@a', '@b'],
      ['/docs/', '@c'],
    ]);
  });
});
