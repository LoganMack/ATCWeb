/**
 * Row filters hide table rows with the `hidden` attribute (so the CSS stripes can skip them); older code
 * used inline `display: none` or the `.hidden` class. Kept free of DOM globals so it can be unit tested.
 */
export interface RowLike {
  hasAttribute(name: string): boolean;
  classList: { contains(token: string): boolean };
  style: { display: string };
}

export function isRowHidden(row: RowLike): boolean {
  return row.hasAttribute('hidden') || row.classList.contains('hidden') || row.style.display === 'none';
}

/** Rows a CSV export should include: visible rows that are not expandable detail rows. */
export function isExportableRow(row: RowLike): boolean {
  return !row.hasAttribute('data-detail-row') && !isRowHidden(row);
}
