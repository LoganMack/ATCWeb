/**
 * The CSV export leaves out rows a filter or the standings slider has hidden. Filters now hide rows with the
 * `hidden` attribute; the older class and inline-style forms still count as hidden.
 */
import { describe, expect, it } from 'vitest';
import { isExportableRow, isRowHidden, type RowLike } from '../../src/scripts/tableRowVisibility';

function fakeRow(opts: { attrs?: string[]; classes?: string[]; display?: string } = {}): RowLike {
  const attrs = new Set(opts.attrs ?? []);
  const classes = new Set(opts.classes ?? []);
  return {
    hasAttribute: (name) => attrs.has(name),
    classList: { contains: (token) => classes.has(token) },
    style: { display: opts.display ?? '' },
  };
}

describe('isRowHidden', () => {
  it('treats the hidden attribute as hidden', () => {
    expect(isRowHidden(fakeRow({ attrs: ['hidden'] }))).toBe(true);
  });

  it('treats the .hidden class as hidden', () => {
    expect(isRowHidden(fakeRow({ classes: ['hidden'] }))).toBe(true);
  });

  it('treats inline display none as hidden', () => {
    expect(isRowHidden(fakeRow({ display: 'none' }))).toBe(true);
  });

  it('keeps a plain visible row', () => {
    expect(isRowHidden(fakeRow())).toBe(false);
  });
});

describe('isExportableRow', () => {
  it('exports visible driver rows', () => {
    expect(isExportableRow(fakeRow())).toBe(true);
  });

  it('skips detail rows even when expanded', () => {
    expect(isExportableRow(fakeRow({ attrs: ['data-detail-row'] }))).toBe(false);
  });

  it('skips rows the standings slider hid', () => {
    expect(isExportableRow(fakeRow({ attrs: ['hidden'] }))).toBe(false);
  });
});
