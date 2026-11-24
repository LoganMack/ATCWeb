/**
 * The Results menu's track-name truncation (nav-side-menus BR1.13; AC3.5.1-AC3.5.3): over 20 visible
 * characters is cut to 20 plus "…", counted by grapheme cluster, never splitting a character.
 */
import { describe, expect, it } from 'vitest';
import { codePointSegment, defaultSegment, truncateLabel } from '../../src/lib/truncateLabel';

const graphemes = (text: string) => defaultSegment(text, Number.MAX_SAFE_INTEGER).length;

describe('truncateLabel (BR1.13)', () => {
  it('cuts a long track name to 20 characters plus an ellipsis', () => {
    expect(truncateLabel('Portland International Raceway')).toEqual({
      text: 'Portland Internation…',
      truncated: true,
    });
  });

  it('leaves exactly 20 characters unchanged (AC3.5.2)', () => {
    const twenty = 'Circuit de Spa 12345';
    expect(twenty).toHaveLength(20);
    expect(truncateLabel(twenty)).toEqual({ text: twenty, truncated: false });
  });

  it('leaves a shorter label unchanged', () => {
    expect(truncateLabel('Sonoma')).toEqual({ text: 'Sonoma', truncated: false });
  });

  it('takes one character off a 21-character label and adds the ellipsis', () => {
    const label = 'Circuit de Spa 123456';
    expect(label).toHaveLength(21);
    expect(truncateLabel(label)).toEqual({ text: 'Circuit de Spa 12345…', truncated: true });
  });

  it('keeps a trailing space at the cut, as FR3.3 reads', () => {
    expect(truncateLabel('Autodromo Nazionale Monza').text).toBe('Autodromo Nazionale …');
  });

  it('counts accented letters by what is seen, precomposed or with combining marks (AC3.5.3)', () => {
    const precomposed = 'Autódromo Hermanos Rodríguez'.normalize('NFC');
    const combining = 'Autódromo Hermanos Rodríguez'.normalize('NFD');
    expect(combining.length).toBeGreaterThan(precomposed.length);
    const a = truncateLabel(precomposed);
    const b = truncateLabel(combining);
    expect(a).toEqual({ text: 'Autódromo Hermanos R…', truncated: true });
    expect(b.truncated).toBe(true);
    expect(b.text.normalize('NFC')).toBe(a.text);
    // The cut never separates a letter from its accent.
    expect(graphemes(b.text)).toBe(21);
  });

  it('counts an emoji flag as one character and never splits it', () => {
    const flagged = '\u{1F1FA}\u{1F1F8} ' + 'x'.repeat(18); // flag, space, 18 letters: 20 visible
    expect(truncateLabel(flagged)).toEqual({ text: flagged, truncated: false });
    const longer = 'x'.repeat(19) + '\u{1F1FA}\u{1F1F8}y';
    expect(truncateLabel(longer)).toEqual({ text: 'x'.repeat(19) + '\u{1F1FA}\u{1F1F8}…', truncated: true });
  });

  it('gives the empty string, not truncated, for a missing or empty label', () => {
    expect(truncateLabel(null)).toEqual({ text: '', truncated: false });
    expect(truncateLabel(undefined)).toEqual({ text: '', truncated: false });
    expect(truncateLabel('')).toEqual({ text: '', truncated: false });
  });

  it('falls back to code points when there is no grapheme segmenter', () => {
    expect(truncateLabel('Portland International Raceway', 20, codePointSegment)).toEqual({
      text: 'Portland Internation…',
      truncated: true,
    });
    // Code points keep surrogate pairs whole, but a combining mark counts on its own.
    expect(codePointSegment('e\u0301\u{1F600}', 5)).toEqual(['e', '\u0301', '\u{1F600}']);
    expect(truncateLabel('ab\u{1F600}d', 3, codePointSegment)).toEqual({
      text: 'ab\u{1F600}…',
      truncated: true,
    });
  });

  it('asks the segmenter for one more than the limit only', () => {
    const calls: number[] = [];
    const spy = (text: string, limit: number) => {
      calls.push(limit);
      return codePointSegment(text, limit);
    };
    truncateLabel('Portland International Raceway', 20, spy);
    expect(calls).toEqual([21]);
  });
});
