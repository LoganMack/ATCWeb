/**
 * Generic "export this table to CSV" behavior for any button carrying
 * `data-csv-export="<table id>"` (and optionally `data-csv-filename="…"`
 * for the downloaded file's base name, timestamp appended below).
 *
 * Reads whatever's currently rendered in that table's `<thead>`/`<tbody>`
 * at click time — it doesn't re-derive or re-fetch anything of its own.
 * That's deliberate: standings.astro/team-standings.astro render a
 * completely different `<table>` (different columns, different markup)
 * for List vs Matrix mode, both sharing one `id` across their
 * mutually-exclusive server-rendered branches (only one mode's block ever
 * renders per page load) — this never needs to know which one is live, or
 * be kept in sync with either one's column set, since it just serializes
 * whatever table element it finds by that id.
 *
 * Detail/expand rows (`[data-detail-row]`, see expandRows.ts) are always
 * skipped — those repeat the same driver/team as the summary row right
 * before them in a different layout, not a new record for the export.
 * Columns hidden at the current viewport width (`hidden sm:table-cell`
 * etc.) are still exported in full — a CSV isn't screen-width-constrained
 * the way the page is, so there's no reason to drop data just because a
 * narrow window currently hides it.
 */
function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function tableToCsv(table: HTMLTableElement): string {
  const lines: string[] = [];

  const headerRow = table.tHead?.rows[0];
  if (headerRow) {
    lines.push(Array.from(headerRow.cells).map((th) => csvField(cellText(th))).join(','));
  }

  const tbody = table.tBodies[0];
  if (tbody) {
    Array.from(tbody.rows)
      .filter((row) => !row.hasAttribute('data-detail-row'))
      .forEach((row) => {
        lines.push(Array.from(row.cells).map((cell) => csvField(cellText(cell))).join(','));
      });
  }

  // CRLF per RFC 4180 — Excel (the overwhelmingly likely opener here) is
  // the pickiest of any common CSV consumer about this.
  return lines.join('\r\n');
}

function downloadCsv(filenameBase: string, csv: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  // Leading UTF-8 BOM so Excel on Windows doesn't guess a legacy code page
  // for non-ASCII text (accented driver names, etc.) — without it, Excel
  // ignores the Blob's own charset=utf-8 and mangles anything outside
  // plain ASCII.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initCsvExportButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-csv-export]').forEach((button) => {
    if (button.dataset.csvExportInit === 'true') return;
    button.dataset.csvExportInit = 'true';

    button.addEventListener('click', () => {
      const tableId = button.dataset.csvExport;
      const table = tableId ? document.getElementById(tableId) : null;
      if (!table || !(table instanceof HTMLTableElement)) return;

      downloadCsv(button.dataset.csvFilename || 'export', tableToCsv(table));
    });
  });
}

document.addEventListener('astro:page-load', initCsvExportButtons);
