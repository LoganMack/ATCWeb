/**
 * Click-to-sort for any `<table data-sortable>`: headers set `data-sort-key`, cells the matching `data-col`.
 * Cell text is compared (numbers numerically); `data-sort-value` overrides it, e.g. the Roster's "3/11" PP
 * cell sorts by the 3.
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

      units.sort((a, b) => {
        const av = getSortValue(a.primary, key);
        const bv = getSortValue(b.primary, key);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
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

document.addEventListener('astro:page-load', initSortableTables);
