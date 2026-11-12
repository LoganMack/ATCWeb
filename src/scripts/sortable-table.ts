/**
 * Click-to-sort for any `<table data-sortable>`: headers set `data-sort-key`, cells the matching `data-col`.
 * Cell text is compared (numbers numerically); `data-sort-value` overrides it, e.g. the Roster's "3/11" PP
 * cell sorts by the 3.
 */

// A control marked `data-sort-reset` (a CSS-only toggle's radio) puts the sortable tables in its parent
// element back in their rendered order when its change hides the sorted column, so a table never stays
// sorted by a column nobody can see. Fragments need no script of their own for this.
const resetWhenHidden = new WeakMap<HTMLTableElement, () => void>();
function getSortValue(row: HTMLTableRowElement, key: string): string | number {
  const cell = row.querySelector<HTMLElement>(`[data-col="${key}"]`);
  if (!cell) return '';
  const raw = cell.dataset.sortValue ?? cell.textContent?.trim() ?? '';
  if (raw === '') return '';
  const num = Number(raw);
  return Number.isNaN(num) ? raw.toLowerCase() : num;
}

function isMissing(row: HTMLTableRowElement, key: string): boolean {
  return row.querySelector(`[data-col="${key}"]`)?.hasAttribute('data-sort-missing') ?? false;
}

/** One sortable value: what it compares by, and whether the cell is marked `data-sort-missing`. */
export interface SortEntry {
  value: string | number;
  missing: boolean;
}

/**
 * Compares two rows' values for direction `dir` (1 or -1). A missing value goes after a present one whichever
 * way the column is sorted, and two missing values keep their order (BR2.3).
 */
export function compareSortEntries(a: SortEntry, b: SortEntry, dir: number): number {
  if (a.missing || b.missing) return a.missing === b.missing ? 0 : a.missing ? 1 : -1;
  if (a.value < b.value) return -1 * dir;
  if (a.value > b.value) return 1 * dir;
  return 0;
}

function initSortableTables() {
  document.querySelectorAll<HTMLTableElement>('table[data-sortable]').forEach((table) => {
    if (table.dataset.sortableInit === 'true') return;
    table.dataset.sortableInit = 'true';

    const headerRow = table.tHead?.rows[0];
    const tbody = table.tBodies[0];
    if (!headerRow || !tbody) return;

    let activeKey: string | null = null;
    let activeHeader: HTMLTableCellElement | null = null;
    let dir = 1;

    const headers = Array.from(headerRow.querySelectorAll<HTMLTableCellElement>('th[data-sort-key]'));
    const renderedOrder = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));

    resetWhenHidden.set(table, () => {
      // getClientRects is empty for a header that display:none hides.
      if (!activeHeader || activeHeader.getClientRects().length > 0) return;
      renderedOrder.forEach((row) => tbody.appendChild(row));
      headers.forEach((h) => h.removeAttribute('data-sort-dir'));
      activeKey = null;
      activeHeader = null;
      dir = 1;
    });

    const runSort = (th: HTMLTableCellElement) => {
      const key = th.dataset.sortKey!;
      dir = activeKey === key ? -dir : 1;
      activeKey = key;
      activeHeader = th;

      // An expandable row and its following `[data-detail-row]` sort as one unit, so the detail row stays
      // next to its summary row.
      const allRows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
      const units: { primary: HTMLTableRowElement; detail: HTMLTableRowElement | null }[] = [];
      for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        if (row.hasAttribute('data-detail-row')) continue; // consumed below, as the previous row's detail
        const next = allRows[i + 1];
        const detail = next && next.hasAttribute('data-detail-row') ? next : null;
        units.push({ primary: row, detail });
      }

      const entry = (row: HTMLTableRowElement): SortEntry => ({
        value: getSortValue(row, key),
        missing: isMissing(row, key),
      });
      units.sort((a, b) => compareSortEntries(entry(a.primary), entry(b.primary), dir));
      units.forEach(({ primary, detail }) => {
        tbody.appendChild(primary);
        if (detail) tbody.appendChild(detail);
      });

      headers.forEach((h) => h.removeAttribute('data-sort-dir'));
      th.setAttribute('data-sort-dir', dir === 1 ? 'asc' : 'desc');
    };

    headers.forEach((th) => {
      th.classList.add('cursor-pointer', 'select-none', 'hover:text-white');
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', () => runSort(th));
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          runSort(th);
        }
      });
    });
  });
}

// Guarded so tests can import the comparator without a DOM.
if (typeof document !== 'undefined') {
  document.addEventListener('astro:page-load', initSortableTables);

  document.addEventListener('change', (e) => {
    const control = e.target instanceof Element ? e.target.closest('[data-sort-reset]') : null;
    control?.parentElement
      ?.querySelectorAll<HTMLTableElement>('table[data-sortable]')
      .forEach((table) => resetWhenHidden.get(table)?.());
  });
}
