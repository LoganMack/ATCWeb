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

      // A click-to-expand table (standings.astro, team-standings.astro,
      // driver-stats.astro) pairs each sortable row with its own sibling
      // `[data-detail-row]` right after it. Sorting the raw list of
      // `:scope > tr` would treat that detail row as its own independent
      // row — it never matches any `[data-col]` sort key, so every detail
      // row in the table sorts to one end as a clump, getting separated
      // from the summary row it belongs to. From that point on, a summary
      // row's `nextElementSibling` (what the expand/collapse handler reads)
      // is some OTHER row entirely, not its own detail panel — clicking to
      // expand looks like it does nothing, and toggling it actually shows/
      // hides whatever unrelated row now happens to sit next to it. Treating
      // each `[data-expand-row]` + its immediately-following `[data-detail-row]`
      // as one unit that always moves together fixes that; a table with no
      // detail rows at all (every other sortable table on the site) behaves
      // exactly as before, since every row is then just its own one-row unit.
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
