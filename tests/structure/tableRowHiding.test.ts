/**
 * Table stripes count only visible rows, and CSS cannot see inline styles, so scripts that hide table rows
 * must use the `hidden` attribute (NFR4.5). The names row, detail, r.row and r.detail are only ever used for
 * table rows; hiding other elements (form fields, grid items, chart groups) is out of scope.
 */
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob(['/src/**/*.astro', '/src/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Assignments only: reading the inline style to detect older hiding (tableRowVisibility.ts) is fine.
const ROW_STYLE_DISPLAY = /\b(?:row|detail|r\.row|r\.detail)\.style\.display\s*=(?!=)/;

describe('table row hiding', () => {
  it('the pattern catches the old inline style form', () => {
    expect(ROW_STYLE_DISPLAY.test("row.style.display = matches ? '' : 'none';")).toBe(true);
    expect(ROW_STYLE_DISPLAY.test("if (r.detail) r.detail.style.display = '';")).toBe(true);
    expect(ROW_STYLE_DISPLAY.test("guide.style.display = 'none';")).toBe(false);
    expect(ROW_STYLE_DISPLAY.test("row.style.display === 'none'")).toBe(false);
  });

  it('no script hides table rows with style.display', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, text]) => ROW_STYLE_DISPLAY.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
