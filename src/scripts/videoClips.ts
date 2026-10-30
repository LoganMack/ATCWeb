/**
 * Incident clips on the incidents page: Watch video ([data-open-video]) opens the shell's player popup, and
 * Add/Edit Video ([data-edit-video], admins only) opens the fragment's link editor. Click handlers are
 * delegated from the document, so buttons the fragment loader swaps in, and the details popup's buttons whose
 * data is filled in on open, work without re-binding.
 */
import { normalizeClipUrl } from '../lib/clipLink';
import { buildClipPlayer } from './videoPlayer';

/** What an Add/Edit Video button carries (data-edit-video). */
export interface VideoEditSpec {
  intent: 'set-report-video' | 'set-incident-video';
  /** "report:<id>" or "incident:<type>:<race>:<number>": which dialog a refused save re-opens. */
  target: string;
  fields: Record<string, string>;
  url: string;
  heading: string;
}

const DRAFT_KEY = 'incident-video-draft';

function openPlayer(url: string, title: string) {
  const dialog = document.querySelector<HTMLDialogElement>('[data-video-player-dialog]');
  const frame = dialog?.querySelector<HTMLElement>('[data-video-player-frame]');
  if (!dialog || !frame) return;
  const player = buildClipPlayer(document, url);
  if (!player) return;
  const titleEl = dialog.querySelector<HTMLElement>('[data-video-player-title]');
  if (titleEl) titleEl.textContent = title || 'Incident video';
  frame.replaceChildren(player);
  dialog.showModal();
}

function parseSpec(raw: string | undefined): VideoEditSpec | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VideoEditSpec;
  } catch {
    return null;
  }
}

function openEditor(spec: VideoEditSpec, showError: boolean) {
  const dialog = document.querySelector<HTMLDialogElement>('[data-video-url-dialog]');
  if (!dialog) return;
  const title = dialog.querySelector<HTMLElement>('[data-video-dialog-title]');
  const heading = dialog.querySelector<HTMLElement>('[data-video-dialog-heading]');
  const intent = dialog.querySelector<HTMLInputElement>('[data-video-intent]');
  const input = dialog.querySelector<HTMLInputElement>('[data-video-url-input]');
  const error = dialog.querySelector<HTMLElement>('[data-video-url-error]');
  if (!intent || !input) return;
  if (title) title.textContent = spec.url ? 'Edit Video' : 'Add Video';
  if (heading) heading.textContent = spec.heading ?? '';
  intent.value = spec.intent;
  // Only the ids this clip needs are sent; the others stay disabled.
  dialog.querySelectorAll<HTMLInputElement>('[data-video-field]').forEach((field) => {
    const key = field.dataset.videoField ?? '';
    const has = Object.hasOwn(spec.fields ?? {}, key);
    field.disabled = !has;
    field.value = has ? String(spec.fields[key]) : '';
  });
  input.value = spec.url ?? '';
  error?.classList.toggle('hidden', !showError);
  dialog.dataset.videoTarget = spec.target;
  dialog.dataset.videoSpec = JSON.stringify(spec);
  dialog.showModal();
  input.focus();
}

function bindOnce() {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target?.closest) return;

    const watch = target.closest<HTMLElement>('[data-open-video]');
    if (watch?.dataset.videoUrl) {
      openPlayer(watch.dataset.videoUrl, watch.dataset.videoTitle ?? '');
      return;
    }

    const edit = target.closest<HTMLButtonElement>('[data-edit-video]');
    if (edit && !edit.disabled) {
      const spec = parseSpec(edit.dataset.editVideo);
      if (!spec) return;
      // From inside the Incident Details popup: close it first so only one form is on screen.
      edit.closest<HTMLDialogElement>('dialog[open]')?.close();
      openEditor(spec, false);
      return;
    }

    if (target.closest('[data-close-video-player]')) {
      target.closest<HTMLDialogElement>('dialog')?.close();
      return;
    }
    if (target.closest('[data-close-video-url-dialog]')) {
      target.closest<HTMLDialogElement>('dialog')?.close();
      return;
    }
    // A click on a popup's backdrop (the dialog itself) closes it.
    if (target instanceof HTMLDialogElement && target.matches('[data-video-player-dialog]')) target.close();
  });

  // Closing the player (✕, Esc or backdrop) removes it, so a clip never keeps playing out of sight.
  document.addEventListener(
    'close',
    (event) => {
      const dialog = event.target as Element | null;
      if (dialog instanceof HTMLDialogElement && dialog.matches('[data-video-player-dialog]')) {
        dialog.querySelector('[data-video-player-frame]')?.replaceChildren();
      }
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as Element | null;
      if (!(form instanceof HTMLFormElement) || !form.matches('[data-video-url-form]')) return;
      const dialog = form.closest<HTMLDialogElement>('[data-video-url-dialog]');
      const input = form.querySelector<HTMLInputElement>('[data-video-url-input]');
      if (!dialog || !input) return;
      const check = normalizeClipUrl(input.value);
      if (!check.ok) {
        event.preventDefault();
        dialog.querySelector('[data-video-url-error]')?.classList.remove('hidden');
        return;
      }
      // Kept for this tab only, so a save the server refuses re-opens with what was typed (the link never
      // goes into the URL). sessionStorage can throw; the draft is a nicety.
      const spec = parseSpec(dialog.dataset.videoSpec);
      if (!spec) return;
      try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...spec, url: input.value }));
      } catch {
        /* no draft, no harm */
      }
    },
    true,
  );
}

/** After each render: re-open the editor a refused save came back to, or drop a stale draft. */
function restoreDraft() {
  const dialog = document.querySelector<HTMLDialogElement>('[data-video-url-dialog]');
  if (!dialog || dialog.dataset.videoRestored) return;
  dialog.dataset.videoRestored = 'true';
  const refusedFor = dialog.dataset.videoError ?? '';
  try {
    if (!refusedFor) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }
    const draft = parseSpec(sessionStorage.getItem(DRAFT_KEY) ?? undefined);
    if (draft && draft.target === refusedFor) openEditor(draft, true);
  } catch {
    /* storage unavailable: the flash still says what went wrong */
  }
}

if (typeof document !== 'undefined') {
  bindOnce();
  document.addEventListener('astro:page-load', restoreDraft);
}
