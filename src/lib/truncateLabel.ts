/**
 * Shortens a label to a number of visible characters (nav-side-menus BR1.13), for the Results menu's track
 * names. It counts grapheme clusters, so an accented letter, a combining mark or an emoji flag is one character
 * and is never split. No imports: it runs in the browser.
 */

/** Returns the first `limit` characters of `text`, one string per character. */
export type SegmentFn = (text: string, limit: number) => string[];

export type TruncatedLabel = { text: string; truncated: boolean };

const ELLIPSIS = '…';

// Created on first use and reused: building a segmenter costs far more than segmenting a short label.
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/** Code points, for engines without Intl.Segmenter: a combining mark then counts as its own character. */
export function codePointSegment(text: string, limit: number): string[] {
  return Array.from(text).slice(0, limit);
}

/** Grapheme clusters, stopping once `limit` are found; code points where Intl.Segmenter is missing. */
export function defaultSegment(text: string, limit: number): string[] {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('en', { granularity: 'grapheme' })
        : null;
  }
  if (!graphemeSegmenter) return codePointSegment(text, limit);
  const out: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (out.length >= limit) break;
    out.push(segment);
  }
  return out;
}

/**
 * Over `max` visible characters gives the first `max` plus "…" (a trailing space is kept, as FR3.3 reads);
 * `max` or fewer is unchanged; a missing or empty label gives the empty string.
 */
export function truncateLabel(
  text: string | null | undefined,
  max = 20,
  segment: SegmentFn = defaultSegment,
): TruncatedLabel {
  if (!text) return { text: '', truncated: false };
  const head = segment(text, max + 1);
  if (head.length <= max) return { text, truncated: false };
  return { text: head.slice(0, max).join('') + ELLIPSIS, truncated: true };
}
