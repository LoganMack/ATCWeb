// "Incident Details" popup — opens when an incident row ([data-history-incident])
// is clicked, tapped, or activated with Enter/Space. Shared by History →
// Incidents (src/pages/incidents.astro) and the Event Briefing page's Past
// Incidents table; the rows and the <dialog> come from IncidentsAllTable.astro
// and IncidentDetailsDialog.astro. Listeners are delegated on `document`
// because on History → Incidents the markup arrives via a fetched fragment,
// where <script> tags never run (see drivers/[id]/fragment.astro's header).
// Each row only carries its incident's id; the details live once in the
// page's JSON block.
let summaryCache: { source: Element; data: Record<string, any> } | null = null;

function readSummaries(): Record<string, any> {
  const source = document.querySelector('[data-history-incident-data]');
  if (!source) return {};
  // Re-read whenever a new JSON block has replaced the old one (a fresh fragment).
  if (summaryCache?.source === source) return summaryCache.data;
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(source.textContent ?? '{}');
  } catch {
    data = {};
  }
  summaryCache = { source, data };
  return data;
}

function openIncidentDetails(row: HTMLElement) {
  const dialog = document.querySelector<HTMLDialogElement>('[data-history-incident-dialog]');
  if (!dialog) return;
  const summary = readSummaries()[row.dataset.historyIncident ?? ''];
  if (!summary) return;
  const set = (name: string, text: string) => {
    const el = dialog.querySelector<HTMLElement>(`[data-hi="${name}"]`);
    if (el) el.textContent = text;
  };
  const show = (name: string, visible: boolean) => {
    dialog.querySelector<HTMLElement>(`[data-hi-row="${name}"]`)?.classList.toggle('hidden', !visible);
  };
  set('round', `${summary.track} · ${summary.round}`);
  set('when', `${summary.season} · ${summary.session} · ${summary.date}`);
  set('driver', summary.driver ?? '—');
  set('number', summary.incidentNumber ?? '—');
  set('lap', summary.lap != null ? String(summary.lap) : '—');
  const involved: string[] = summary.involved ?? [];
  show('involved', involved.length > 0);
  set('involved', involved.join(', '));
  show('description', Boolean(summary.description));
  set('description', summary.description ?? '');
  const offenses: string[] = summary.offenses ?? [];
  show('offenses', offenses.length > 0);
  dialog.querySelector<HTMLElement>('[data-hi="offenses"]')?.replaceChildren(
    ...offenses.map((name) => {
      const div = document.createElement('div');
      div.textContent = name;
      return div;
    })
  );
  set('pp', summary.isWarning ? 'Warning' : summary.pp ? String(summary.pp) : '—');
  set('time', summary.time ? `+${summary.time}s` : '—');
  set('points', summary.points ? String(summary.points) : '—');
  show('appealed', Boolean(summary.isAppealed));
  dialog.querySelector<HTMLAnchorElement>('[data-hi-link="round"]')?.setAttribute('href', summary.roundHref);
  dialog.querySelector<HTMLAnchorElement>('[data-hi-link="report"]')?.setAttribute('href', summary.href);
  dialog.showModal();
}

// Module-scoped (not a flag on document.body, which the client router swaps) so the document listeners are only added once.
let initialized = false;
function initIncidentDetails() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-history-incident]');
    if (row) {
      openIncidentDetails(row);
      return;
    }
    if (target.closest('[data-close-history-incident]')) {
      target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop (the <dialog> element itself, outside its content) closes it.
    if (target instanceof HTMLDialogElement && target.hasAttribute('data-history-incident-dialog')) target.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-history-incident]');
    if (!row) return;
    e.preventDefault();
    openIncidentDetails(row);
  });
}

initIncidentDetails();

// Marks this file as a module so its top-level names stay local to it.
export {};
