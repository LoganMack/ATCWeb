// The stewards' Edit Submission popup on the incidents page (broadcaster-staff-roles C8, BR4.3): an Edit
// Submission button carries the report's Race, Lap, Turns and Cars as JSON (data-edit-submission); this fills
// the edit-mode ReportIncidentDialog with them and opens it. Delegated and bound once, because the dialog and
// buttons arrive in a fetched fragment. The server re-checks everything, under a lock, when it saves.

export interface SubmissionPrefill {
  report_id: string;
  session: string;
  lap: number | null;
  turn: string;
  driver_ids: string[];
}

/** Reads a button's data-edit-submission JSON; anything unexpected becomes empty fields, never an error. */
export function parseSubmissionPrefill(raw: string | undefined): SubmissionPrefill | null {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!parsed || typeof parsed !== 'object') return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof data.report_id !== 'string' || data.report_id === '') return null;
  return {
    report_id: data.report_id,
    session: typeof data.session === 'string' ? data.session : '',
    lap: typeof data.lap === 'number' && Number.isInteger(data.lap) ? data.lap : null,
    turn: typeof data.turn === 'string' ? data.turn : '',
    driver_ids: Array.isArray(data.driver_ids)
      ? data.driver_ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function fillForm(form: HTMLFormElement, prefill: SubmissionPrefill): void {
  form.reset();
  const set = (name: string, value: string) => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (field) field.value = value;
  };
  set('report_id', prefill.report_id);
  set('session', prefill.session);
  set('lap', prefill.lap === null ? '' : String(prefill.lap));
  set('turn', prefill.turn);
  const picked = new Set(prefill.driver_ids);
  form.querySelectorAll('[data-edit-extra-car]').forEach((el) => el.remove());
  const offered = new Set<string>();
  form.querySelectorAll<HTMLInputElement>('input[name="involved_driver_ids"]').forEach((box) => {
    offered.add(box.value);
    box.checked = picked.has(box.value);
  });
  // A report car the picker doesn't list (not in this round's results) is kept rather than silently dropped.
  for (const id of picked) {
    if (offered.has(id)) continue;
    const keep = document.createElement('input');
    keep.type = 'hidden';
    keep.name = 'involved_driver_ids';
    keep.value = id;
    keep.dataset.editExtraCar = '';
    form.append(keep);
  }
  // Re-run the picker's filter so every ticked car shows (driverPickerSearch.ts keeps checked ones).
  const search = form.querySelector<HTMLInputElement>('[data-driver-search]');
  if (search) {
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

let initialized = false;
function initEditSubmissionDialog(): void {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-edit-submission-dialog]');
    if (!dialog) return;
    const trigger = target.closest<HTMLElement>('[data-edit-submission]');
    if (trigger) {
      const prefill = parseSubmissionPrefill(trigger.dataset.editSubmission);
      const form = dialog.querySelector<HTMLFormElement>('[data-edit-submission-form]');
      if (!prefill || !form || dialog.open) return;
      fillForm(form, prefill);
      dialog.showModal();
      return;
    }
    // The ✕, Cancel, or a click on the backdrop (the <dialog> itself).
    if (target.closest('[data-close-edit-submission]') || target === dialog) dialog.close();
  });
}

if (typeof document !== 'undefined') {
  initEditSubmissionDialog();
  document.addEventListener('astro:page-load', initEditSubmissionDialog);
}
