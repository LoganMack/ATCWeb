// Shared upload dialog on /admin/import. The panel texts come from a
// <script type="application/json" id="import-panels"> block (data, not code), so
// the page needs no inline script under the strict CSP. One delegated listener,
// registered once, so it survives client-side navigation.

interface ImportPanel {
  kind: string;
  title: string;
  intent: string;
  help: string;
  writesTo: string;
}

function readPanels(): ImportPanel[] {
  const raw = document.getElementById('import-panels')?.textContent;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ImportPanel[];
  } catch (err) {
    console.error('Import panels data is not valid JSON:', err);
    return [];
  }
}

function openUploadDialog(btn: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-upload-dialog]');
  if (!dialog) return;
  const kind = btn.dataset.kind;
  const panel = readPanels().find((p) => p.kind === kind);
  if (!panel || !kind) return;

  const setText = (selector: string, text: string) => {
    const el = dialog.querySelector(selector);
    if (el) el.textContent = text;
  };
  setText('[data-dialog-title]', panel.title);
  setText('[data-dialog-event-label]', btn.dataset.eventLabel || '');
  setText('[data-dialog-writes-to]', `Writes to: ${panel.writesTo}`);
  setText('[data-dialog-help]', panel.help);

  const intentField = dialog.querySelector<HTMLInputElement>('[data-dialog-intent-field]');
  if (intentField) intentField.value = panel.intent;

  const templateLink = dialog.querySelector<HTMLAnchorElement>('[data-dialog-template-link]');
  if (templateLink) {
    const eventId = btn.dataset.eventId;
    templateLink.href = eventId
      ? `/api/import-templates/${kind}.csv?eventId=${encodeURIComponent(eventId)}`
      : `/api/import-templates/${kind}.csv`;
  }

  dialog.showModal();
}

function initImportUploadDialog(): void {
  if (document.body.dataset.importUploadInit === 'true') return;
  document.body.dataset.importUploadInit = 'true';
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const opener = target.closest<HTMLElement>('[data-open-upload-dialog]');
    if (opener) {
      openUploadDialog(opener);
      return;
    }
    if (target.closest('[data-close-upload-dialog]')) {
      target.closest('dialog')?.close();
    }
  });
}

initImportUploadDialog();
document.addEventListener('astro:page-load', initImportUploadDialog);
