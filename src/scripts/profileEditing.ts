// Own-profile editing (U3 profile-settings; BR4.1-BR4.4, BR5.1, BR6.2; contract C4), imported by
// src/pages/drivers/[id].astro only. The header's Edit Profile button enters editing mode and then saves;
// Cancel discards held changes (photo, bio, the five checkboxes) after asking; the email buttons post in
// place and never touch held changes. Nothing runs until the page has a profile form (NFR3.2).

import type { InPlaceResult } from '../lib/driverAccount';

/** What Save Profile holds: the bio, whether a photo is picked, and each checkbox by name. */
export interface HeldValues {
  bio: string;
  photoPicked: boolean;
  settings: Record<string, boolean>;
}

/** True when any held field differs from the values the page loaded with. */
export function isDirty(initial: HeldValues, current: HeldValues): boolean {
  if (initial.bio !== current.bio || initial.photoPicked !== current.photoPicked) return true;
  const names = new Set([...Object.keys(initial.settings), ...Object.keys(current.settings)]);
  return [...names].some((name) => Boolean(initial.settings[name]) !== Boolean(current.settings[name]));
}

export interface AvatarLimits {
  types: string[];
  maxBytes: number;
}

/** The browser's photo check before submit (the server repeats it); null when the photo is fine. */
export function photoProblem(file: { type: string; size: number }, limits: AvatarLimits): string | null {
  if (!limits.types.includes(file.type)) return 'Photos must be PNG, JPG or WebP.';
  if (file.size > limits.maxBytes) {
    return `Photos can be at most ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`;
  }
  return null;
}

/**
 * Hiding the name also hides the profile (FR2.5): while hide_name is on, hide_profile is shown on and locked;
 * once it is off, hide_profile is changeable again and keeps the value it shows.
 */
export function forcedPrivacy(
  hideName: boolean,
  hideProfile: boolean,
): { hideProfile: boolean; locked: boolean } {
  return hideName ? { hideProfile: true, locked: true } : { hideProfile, locked: false };
}

export function bioProblem(bio: string, max: number): string | null {
  return bio.trim().length > max ? `Your bio can be at most ${max} characters.` : null;
}

/** The tab arrow keys move to (wrapping), or null for a key the tablist ignores. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export const NETWORK_ERROR_MESSAGE = "Couldn't reach the site. Try again.";
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Try again.';
export const IN_PLACE_TIMEOUT_MS = 10_000;

/** The body of an in-place action: its intent and the fields of its own section, never the held fields. */
export function inPlaceBody(intent: string, fields: Iterable<[string, string]>): FormData {
  const body = new FormData();
  body.set('intent', intent);
  for (const [name, value] of fields) if (name !== 'intent') body.append(name, value);
  return body;
}

function isInPlaceResult(value: unknown): value is InPlaceResult {
  const obj = value as Record<string, unknown> | null;
  return Boolean(obj) && typeof obj?.ok === 'boolean' && typeof obj?.message === 'string';
}

/**
 * Posts an in-place action as multipart FormData, so Astro's origin check applies as to any form, asking for
 * C4's JSON answer. Network failures and the timeout resolve to an error result; it never throws.
 */
export async function postInPlace(
  url: string,
  body: FormData,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<InPlaceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? IN_PLACE_TIMEOUT_MS);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON: handled below.
    }
    return isInPlaceResult(parsed) ? parsed : { ok: false, message: UNEXPECTED_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: NETWORK_ERROR_MESSAGE };
  } finally {
    clearTimeout(timer);
  }
}

// --- DOM wiring ----------------------------------------------------------------------------------

let initialValues: HeldValues | null = null;
let submitting = false;

const profileForm = () => document.querySelector<HTMLFormElement>('form[data-profile-form]');
const editToggle = () => document.querySelector<HTMLButtonElement>('[data-profile-edit-toggle]');

function readHeld(form: HTMLFormElement): HeldValues {
  const settings: Record<string, boolean> = {};
  form.querySelectorAll<HTMLInputElement>('input[data-held-setting]').forEach((box) => {
    settings[box.name] = box.checked;
  });
  return {
    bio: form.querySelector<HTMLTextAreaElement>('[data-bio-input]')?.value ?? '',
    photoPicked: Boolean(form.querySelector<HTMLInputElement>('[data-photo-input]')?.files?.length),
    settings,
  };
}

/** A failed save re-renders with the typed values, which are unsaved however they compare. */
function hasUnsavedChanges(form: HTMLFormElement): boolean {
  if (form.dataset.editing !== 'true') return false;
  if (form.querySelector('[data-profile-save-error]')) return true;
  return initialValues !== null && isDirty(initialValues, readHeld(form));
}

function updateUnsaved(form: HTMLFormElement): void {
  const indicator = form.querySelector<HTMLElement>('[data-profile-unsaved]');
  indicator?.classList.toggle('hidden', !hasUnsavedChanges(form));
}

function updateBioCount(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLTextAreaElement>('[data-bio-input]');
  const count = form.querySelector<HTMLElement>('[data-bio-count]');
  if (!input || !count) return;
  count.textContent = String(input.value.length);
  count.classList.toggle('text-brand-pink', input.value.length > input.maxLength);
}

function setHeaderButtons(editing: boolean): void {
  const toggle = editToggle();
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(editing));
    toggle.setAttribute('aria-label', editing ? 'Save Profile' : 'Edit Profile');
    toggle.querySelector('[data-profile-icon-edit]')?.classList.toggle('hidden', editing);
    toggle.querySelector('[data-profile-icon-save]')?.classList.toggle('hidden', !editing);
  }
  const tooltip = document.querySelector<HTMLElement>('[data-profile-edit-tooltip]');
  if (tooltip) tooltip.textContent = editing ? 'Save Profile' : 'Edit Profile';
  document.querySelector('[data-profile-cancel-wrap]')?.classList.toggle('hidden', !editing);
}

function setEditing(form: HTMLFormElement, editing: boolean): void {
  form.querySelectorAll<HTMLElement>('[data-edit-only]').forEach((el) => {
    el.classList.toggle('hidden', !editing);
    // The photo overlay is a flex box when shown, everything else is block.
    if (el.tagName === 'LABEL') el.classList.toggle('flex', editing);
  });
  form
    .querySelectorAll<HTMLElement>('[data-view-only]')
    .forEach((el) => el.classList.toggle('hidden', editing));
  // The tabs replace the statistics and related news while editing (BR5.1).
  form.querySelector('[data-profile-tabs-root]')?.classList.toggle('hidden', !editing);
  document.querySelector('[data-driver-results]')?.classList.toggle('hidden', editing);
  setHeaderButtons(editing);
  form.dataset.editing = editing ? 'true' : 'false';
  const live = form.querySelector<HTMLElement>('[data-profile-live]');
  if (live) live.textContent = editing ? 'Editing your profile' : '';
  if (editing) {
    initialValues = readHeld(form);
    updateBioCount(form);
  }
  updateUnsaved(form);
}

function clearPhoto(form: HTMLFormElement): void {
  const preview = form.querySelector<HTMLImageElement>('[data-photo-preview]');
  if (preview) {
    if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.removeAttribute('src');
    preview.classList.add('hidden');
  }
  const err = form.querySelector<HTMLElement>('[data-photo-error]');
  if (err) err.textContent = '';
}

/** Applies forcedPrivacy to the two boxes; a locked box isn't posted, so its hidden stand-in is enabled. */
function applyPrivacyForce(form: HTMLFormElement): void {
  const source = form.querySelector<HTMLInputElement>('input[data-privacy-force="source"]');
  const target = form.querySelector<HTMLInputElement>('input[data-privacy-force="target"]');
  const standIn = form.querySelector<HTMLInputElement>('input[data-privacy-forced-value]');
  // Both boxes are disabled when the saved choices couldn't be loaded; leave them so.
  if (!source || !target || source.disabled) return;
  const forced = forcedPrivacy(source.checked, target.checked);
  target.checked = forced.hideProfile;
  target.disabled = forced.locked;
  if (standIn) standIn.disabled = !forced.locked;
}

/** Back to the saved values and view mode. After a failed save the page itself holds the unsaved values. */
function discard(form: HTMLFormElement): void {
  if (form.querySelector('[data-profile-save-error]')) {
    submitting = true; // the reload is the discard, so the leave-page warning must not ask again
    window.location.assign(window.location.pathname);
    return;
  }
  form.reset();
  applyPrivacyForce(form);
  clearPhoto(form);
  setEditing(form, false);
  editToggle()?.focus();
}

function avatarLimits(form: HTMLFormElement): AvatarLimits {
  return {
    types: (form.dataset.avatarTypes ?? '').split(',').filter(Boolean),
    maxBytes: Number(form.dataset.avatarMaxBytes ?? 0),
  };
}

function save(form: HTMLFormElement, toggle: HTMLButtonElement): void {
  const err = form.querySelector<HTMLElement>('[data-photo-error]');
  const bio = form.querySelector<HTMLTextAreaElement>('[data-bio-input]')?.value ?? '';
  const problem = bioProblem(bio, Number(form.dataset.bioMax ?? 0));
  if (problem) {
    if (err) err.textContent = problem;
    form.querySelector<HTMLTextAreaElement>('[data-bio-input]')?.focus();
    return;
  }
  submitting = true;
  toggle.disabled = true;
  toggle.setAttribute('aria-busy', 'true');
  form.requestSubmit();
}

function onPhotoChange(form: HTMLFormElement, input: HTMLInputElement): void {
  const err = form.querySelector<HTMLElement>('[data-photo-error]');
  const preview = form.querySelector<HTMLImageElement>('[data-photo-preview]');
  const file = input.files?.[0];
  if (err) err.textContent = '';
  if (file) {
    const problem = photoProblem(file, avatarLimits(form));
    if (problem) {
      if (err) err.textContent = problem;
      input.value = '';
    } else if (preview) {
      if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
      preview.src = URL.createObjectURL(file);
      preview.classList.remove('hidden');
    }
  }
  updateUnsaved(form);
}

function selectTab(form: HTMLFormElement, tab: HTMLElement, focus: boolean): void {
  const tabs = [...form.querySelectorAll<HTMLElement>('[data-profile-tab]')];
  for (const t of tabs) {
    const active = t === tab;
    t.setAttribute('aria-selected', String(active));
    t.setAttribute('tabindex', active ? '0' : '-1');
    t.dataset.active = String(active); // .btn[data-active] styles the selected tab (global.css)
  }
  form.querySelectorAll<HTMLElement>('[data-profile-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.profilePanel !== tab.dataset.profileTab);
  });
  if (focus) tab.focus();
}

function showInPlaceResult(form: HTMLFormElement, intent: string, result: InPlaceResult): void {
  const status = form.querySelector<HTMLElement>(`[data-in-place-status="${intent}"]`);
  if (status) {
    status.textContent = result.message;
    status.classList.toggle('text-brand-pink', !result.ok);
    status.classList.toggle('text-white/70', result.ok);
  }
  const section = form.querySelector<HTMLElement>(`[data-in-place="${intent}"]`);
  const field = result.field ? section?.querySelector<HTMLInputElement>(`[name="${result.field}"]`) : null;
  section?.querySelectorAll('input').forEach((input) => input.removeAttribute('aria-invalid'));
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  } else if (result.ok) {
    section?.querySelectorAll('input').forEach((input) => (input.value = ''));
  }
}

async function runInPlace(form: HTMLFormElement, button: HTMLButtonElement): Promise<void> {
  const intent = button.dataset.inPlaceIntent ?? '';
  const section = form.querySelector<HTMLElement>(`[data-in-place="${intent}"]`);
  if (!intent || !section || button.disabled) return;
  const fields = [...section.querySelectorAll<HTMLInputElement>('input[name]')].map(
    (input): [string, string] => [input.name, input.value],
  );
  const label = button.textContent ?? '';
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    showInPlaceResult(form, intent, await postInPlace(window.location.pathname, inPlaceBody(intent, fields)));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function onClick(e: MouseEvent): void {
  const form = profileForm();
  const target = e.target as HTMLElement | null;
  if (!form || !target) return;
  const toggle = target.closest<HTMLButtonElement>('[data-profile-edit-toggle]');
  if (toggle) {
    if (form.dataset.editing === 'true') save(form, toggle);
    else setEditing(form, true);
    return;
  }
  const dialog = form.querySelector<HTMLDialogElement>('dialog[data-profile-discard-dialog]');
  if (target.closest('[data-profile-cancel]')) {
    if (hasUnsavedChanges(form) && dialog) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-profile-keep-editing]')?.focus();
    } else {
      discard(form);
    }
    return;
  }
  if (target.closest('[data-profile-keep-editing]')) {
    dialog?.close();
    return;
  }
  if (target.closest('[data-profile-discard]')) {
    dialog?.close();
    discard(form);
    return;
  }
  const tab = target.closest<HTMLElement>('[data-profile-tab]');
  if (tab) {
    selectTab(form, tab, false);
    return;
  }
  const action = target.closest<HTMLButtonElement>('[data-in-place-intent]');
  if (action) {
    e.preventDefault();
    void runInPlace(form, action);
  }
}

function onKeydown(e: KeyboardEvent): void {
  const form = profileForm();
  const target = e.target as HTMLElement | null;
  if (!form || !target) return;
  const tab = target.closest<HTMLElement>('[data-profile-tab]');
  if (tab) {
    const tabs = [...form.querySelectorAll<HTMLElement>('[data-profile-tab]')];
    const next = nextTabIndex(tabs.indexOf(tab), e.key, tabs.length);
    if (next !== null) {
      e.preventDefault();
      selectTab(form, tabs[next], true);
    }
    return;
  }
  // Enter in the new-email box sends the link in place instead of submitting the whole form.
  const section = target.closest<HTMLElement>('[data-in-place]');
  if (e.key === 'Enter' && section && target instanceof HTMLInputElement) {
    e.preventDefault();
    const button = section.querySelector<HTMLButtonElement>('[data-in-place-intent]');
    if (button) void runInPlace(form, button);
  }
}

function onFieldChange(e: Event): void {
  const form = profileForm();
  const target = e.target as HTMLElement | null;
  if (!form || !target || !form.contains(target)) return;
  if (target instanceof HTMLInputElement && target.hasAttribute('data-photo-input')) {
    if (e.type === 'change') onPhotoChange(form, target);
    return;
  }
  if (target.hasAttribute('data-bio-input')) updateBioCount(form);
  if (target.getAttribute('data-privacy-force') === 'source') applyPrivacyForce(form);
  updateUnsaved(form);
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  const form = profileForm();
  if (!form || submitting || !hasUnsavedChanges(form)) return;
  e.preventDefault();
  e.returnValue = '';
}

/** Per page: a failed save (or a no-JavaScript email action) comes back in editing mode. */
function initPage(): void {
  submitting = false;
  initialValues = null;
  const form = profileForm();
  if (!form) return;
  const dialog = form.querySelector<HTMLDialogElement>('dialog[data-profile-discard-dialog]');
  if (dialog && dialog.dataset.profileDialogBound !== 'true') {
    dialog.dataset.profileDialogBound = 'true';
    // Escape is "Keep editing": the dialog closes itself; focus goes back to Cancel.
    dialog.addEventListener('close', () =>
      document.querySelector<HTMLElement>('[data-profile-cancel]')?.focus(),
    );
  }
  if (form.hasAttribute('data-start-editing')) setEditing(form, true);
}

// Module-scoped rather than a flag on <body>: the client router swaps <body> on navigation.
let bound = false;
function bindOnce(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('input', onFieldChange);
  document.addEventListener('change', onFieldChange);
  window.addEventListener('beforeunload', onBeforeUnload);
  // A page restored from the back/forward cache mid-save gets its Save Profile button back.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    submitting = false;
    const toggle = editToggle();
    if (toggle) {
      toggle.disabled = false;
      toggle.removeAttribute('aria-busy');
    }
  });
}

if (typeof document !== 'undefined') {
  bindOnce();
  document.addEventListener('astro:page-load', initPage);
}
