// "Incident Details" popup for incident rows ([data-history-incident]) on History → Incidents, the Event
// Briefing and the Stats > Circuits layout rows. Delegated on `document`, since the rows arrive in a fetched
// fragment where scripts don't run. A row inside [data-incident-details-scope] (one per layout row) reads that
// scope's JSON block and dialog; any other row reads the page's first ones.
const summaryCache = new WeakMap<Element, Record<string, any>>();

/** A block's data, parsed once per block element, so a re-fetched fragment's new block is read fresh. */
function readSummaries(block: Element): Record<string, any> {
  const cached = summaryCache.get(block);
  if (cached) return cached;
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(block.textContent ?? '{}');
  } catch {
    data = {};
  }
  summaryCache.set(block, data);
  return data;
}

// The row that opened each dialog, so closing it (Escape, ✕ or the backdrop) puts focus back there.
const openers = new WeakMap<HTMLDialogElement, HTMLElement>();
const closeBound = new WeakSet<HTMLDialogElement>();

function returnFocusOnClose(dialog: HTMLDialogElement) {
  if (closeBound.has(dialog)) return;
  closeBound.add(dialog);
  dialog.addEventListener('close', () => {
    const opener = openers.get(dialog);
    if (opener?.isConnected) opener.focus();
  });
}

function openFromTrigger(trigger: HTMLElement) {
  const scope: ParentNode = trigger.closest('[data-incident-details-scope]') ?? document;
  const block = scope.querySelector('[data-history-incident-data]');
  const dialog = scope.querySelector<HTMLDialogElement>('[data-history-incident-dialog]');
  if (!block || !dialog) return;
  const summary = readSummaries(block)[trigger.dataset.historyIncident ?? ''];
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
  set(
    'title',
    summary.incidentNumber && summary.incidentNumber !== '—'
      ? `Incident ${summary.incidentNumber}`
      : 'Incident',
  );
  set('driver', summary.driver ?? '—');
  set('race', summary.session ?? '—');
  set('lap', summary.lap != null ? String(summary.lap) : '—');
  const involved: string[] = summary.involved ?? [];
  set('involved', involved.length > 0 ? involved.join(', ') : '—');
  show('description', Boolean(summary.description));
  set('description', summary.description ?? '');
  const offenses: string[] = summary.offenses ?? [];
  show('offenses', offenses.length > 0);
  dialog.querySelector<HTMLElement>('[data-hi="offenses"]')?.replaceChildren(
    ...offenses.map((name) => {
      const div = document.createElement('div');
      div.textContent = name;
      return div;
    }),
  );
  set('pp', summary.isWarning ? 'Warning' : summary.pp ? String(summary.pp) : '—');
  set('time', summary.time ? `+${summary.time}s` : '—');
  set('points', summary.points ? String(summary.points) : '—');
  show('appealed', Boolean(summary.isAppealed));
  dialog.querySelector<HTMLAnchorElement>('[data-hi-link="round"]')?.setAttribute('href', summary.roundHref);
  dialog.querySelector<HTMLAnchorElement>('[data-hi-link="report"]')?.setAttribute('href', summary.href);
  openers.set(dialog, trigger);
  returnFocusOnClose(dialog);
  dialog.showModal();
}

const CONTROL_TAGS = ['a', 'button', 'input', 'select', 'textarea'];

/** Whether the click landed on a link or control inside the row (not the row itself), which keeps its own behaviour. */
function insideControl(target: HTMLElement, trigger: HTMLElement): boolean {
  return CONTROL_TAGS.some((tag) => {
    const control = target.closest(tag);
    return control !== null && control !== trigger && trigger.contains(control);
  });
}

// Module-scoped (not a flag on document.body, which the client router swaps) so the document listeners are only added once.
let initialized = false;
function initIncidentDetails() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const trigger = target.closest<HTMLElement>('[data-history-incident]');
    if (trigger) {
      if (insideControl(target, trigger)) return;
      openFromTrigger(trigger);
      return;
    }
    if (target.closest('[data-close-history-incident]')) {
      target.closest('dialog')?.close();
      return;
    }
    // Clicking the backdrop (the <dialog> element itself, outside its content) closes it.
    if (target.tagName === 'DIALOG' && target.hasAttribute('data-history-incident-dialog'))
      (target as HTMLDialogElement).close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const trigger = (e.target as HTMLElement).closest<HTMLElement>('[data-history-incident]');
    // Only the focused row itself opens by key, so Enter on its Round link follows the link.
    if (!trigger || trigger !== e.target) return;
    e.preventDefault();
    openFromTrigger(trigger);
  });
}

initIncidentDetails();

// Marks this file as a module so its top-level names stay local to it.
export {};
