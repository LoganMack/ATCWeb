/**
 * Generic click-to-sort behavior for any `<table data-sortable>`. A header
 * cell opts in with `data-sort-key="foo"`; each body row then needs a
 * matching `<td data-col="foo">` to sort by. By default the cell's own text
 * is what gets compared (numeric text sorts numerically, everything else
 * sorts as case-insensitive text) — set `data-sort-value` on the cell
 * instead when the sort key isn't the same as what's displayed.
 *
 * The Roster's Penalty Points column is the reason this exists: it displays
 * "3/11", but the "/11" is just this season's point allowance (it changes
 * season to season) and has no business affecting sort order. DriverRow sets
 * `data-sort-value={driver.penalty_points}` on that cell so sorting only
 * ever looks at the raw numerator, never the label text.
 */
function getSortValue(row: HTMLTableRowElement, key: string): string | number {
  const cell = row.querySelector<HTMLElement>(`[data-col="${key}"]`);
  if (!cell) return '';
  const raw = cell.dataset.sortValue ?? cell.textContent?.trim() ?? '';
  if (raw === '') return '';
  const num = Number(raw);
  return Number.isNaN(num) ? raw.toLowerCase() : num;
}

function initSortableTables() {
  document.querySelectorAll<HTMLTableElement>('table[data-sortable]').forEach((table) => {
    if (table.dataset.sortableInit === 'true') return;
    table.dataset.sortableInit = 'true';

    const headerRow = table.tHead?.rows[0];
    const tbody = table.tBodies[0];
    if (!headerRow || !tbody) return;

    let activeKey: string | null = null;
    let dir = 1;

    const headers = Array.from(headerRow.querySelectorAll<HTMLTableCellElement>('th[data-sort-key]'));

    const runSort = (th: HTMLTableCellElement) => {
      const key = th.dataset.sortKey!;
      dir = activeKey === key ? -dir : 1;
      activeKey = key;

      const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
      rows.sort((a, b) => {
        const av = getSortValue(a, key);
        const bv = getSortValue(b, key);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
      rows.forEach((row) => tbody.appendChild(row));

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

document.addEventListener('astro:page-load', initSortableTables);
