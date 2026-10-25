/**
 * The rulebook's current-section marker (profile-liveries FR1.2): which contents link carries the dot before
 * the first heading, in the middle of the page and at the very bottom.
 */
import { describe, expect, it } from 'vitest';
import { currentSectionId, currentSectionIndex, READING_LINE_PX } from '../../src/scripts/rulebookContents';

const IDS = ['intro', 'scoring', 'penalties'];

describe('currentSectionIndex', () => {
  it('picks the first section before any heading reaches the reading line', () => {
    expect(currentSectionIndex([400, 1200, 2000], READING_LINE_PX, false)).toBe(0);
  });

  it('picks the last heading that has passed the reading line mid-page', () => {
    expect(currentSectionIndex([-900, 80, 700], READING_LINE_PX, false)).toBe(1);
    expect(currentSectionIndex([-900, READING_LINE_PX, 700], READING_LINE_PX, false)).toBe(1);
  });

  it('picks the last section at the bottom of the page, even when its heading is still low', () => {
    expect(currentSectionIndex([-2000, -900, 500], READING_LINE_PX, true)).toBe(2);
  });

  it('has no current section without headings', () => {
    expect(currentSectionIndex([], READING_LINE_PX, false)).toBe(-1);
    expect(currentSectionId([], [], READING_LINE_PX, true)).toBeNull();
  });
});

describe('currentSectionId', () => {
  it('names the heading id for the chosen section', () => {
    expect(currentSectionId(IDS, [-500, 50, 900], READING_LINE_PX, false)).toBe('scoring');
    expect(currentSectionId(IDS, [300, 900, 1500], READING_LINE_PX, false)).toBe('intro');
  });
});
