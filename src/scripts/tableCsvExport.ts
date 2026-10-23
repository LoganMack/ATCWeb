/**
 * Exports the table named by `data-csv-export="<table id>"` (optional `data-csv-filename`) as CSV, from
 * whatever is rendered at click time, so it works for both List and Matrix views. Detail rows are skipped,
 * hidden-at-this-width columns kept, the `▶` chevron stripped, and a cell's `data-csv-value` wins over its
 * text (for name cells with glued-on badges).
 */
function cellText(cell: Element): string {
  const override = cell.getAttribute('data-csv-value');
  if (override !== null) {
    return override.replace(/\s+/g, ' ').trim();
  }

  return (cell.textContent ?? '')
    .replace(/▶/g, '') // ▶ — see doc comment above
    .replace(/\s+/g, ' ')
    .trim();
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
    lines.push(
      Array.from(headerRow.cells)
        .map((th) => csvField(cellText(th)))
        .join(','),
    );
  }

  const tbody = table.tBodies[0];
  if (tbody) {
    Array.from(tbody.rows)
      .filter((row) => !row.hasAttribute('data-detail-row') && row.style.display !== 'none')
      .forEach((row) => {
        lines.push(
          Array.from(row.cells)
            .map((cell) => csvField(cellText(cell)))
            .join(','),
        );
      });
  }

  // CRLF per RFC 4180 — Excel (the overwhelmingly likely opener here) is
  // the pickiest of any common CSV consumer about this.
  return lines.join('\r\n');
}

function downloadCsv(filenameBase: string, csv: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  // UTF-8 BOM, or Excel on Windows ignores the charset and mangles non-ASCII names.
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

// Run now as well, in case this script first executes after a client-side navigation's astro:page-load.
initCsvExportButtons();
document.addEventListener('astro:page-load', initCsvExportButtons);
