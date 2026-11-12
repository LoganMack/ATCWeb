/**
 * The poll editor (Admin > Polls, new and edit pages): add, remove and reorder sections and options in the
 * browser, keep the hidden `structure` JSON in step, and open a Preview drawn with the public page's renderer
 * (polls BR1.4, BR3.2). The state helpers are pure and tested; the DOM part binds once per page load.
 */
import { pollViewHtml } from '../lib/polls/view';
import { ANSWER_TYPE_LABELS, isAnswerType, type PollView } from '../lib/polls/types';
import {
  blankOption,
  type EditorOption,
  type EditorSection,
  type EditorState,
} from '../lib/polls/editorState';
import { pollImagesBudgetMessage } from '../lib/polls/requestSize';
import { shrinkPollImage } from './pollImageResize';

// --- State -------------------------------------------------------------------------------------------------

function nextKey(state: EditorState): string {
  return `k${state.next_key++}`;
}

export function addSection(state: EditorState): EditorSection {
  const section: EditorSection = {
    id: null,
    key: nextKey(state),
    name: '',
    answer_type: 'single',
    error: null,
    options: [blankOption(nextKey(state)), blankOption(nextKey(state))],
  };
  state.sections.push(section);
  return section;
}

export function addOption(state: EditorState, sectionKey: string): EditorOption | null {
  const section = state.sections.find((s) => s.key === sectionKey);
  if (!section) return null;
  const option = blankOption(nextKey(state));
  section.options.push(option);
  return option;
}

function move<T>(list: T[], index: number, delta: number): boolean {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return false;
  [list[index], list[target]] = [list[target], list[index]];
  return true;
}

export function moveSection(state: EditorState, key: string, delta: -1 | 1): boolean {
  return move(
    state.sections,
    state.sections.findIndex((s) => s.key === key),
    delta,
  );
}

export function removeSection(state: EditorState, key: string): void {
  state.sections = state.sections.filter((s) => s.key !== key);
}

export function findOption(
  state: EditorState,
  key: string,
): { section: EditorSection; option: EditorOption } | null {
  for (const section of state.sections) {
    const option = section.options.find((o) => o.key === key);
    if (option) return { section, option };
  }
  return null;
}

export function moveOption(state: EditorState, key: string, delta: -1 | 1): boolean {
  const found = findOption(state, key);
  if (!found) return false;
  return move(found.section.options, found.section.options.indexOf(found.option), delta);
}

export function removeOption(state: EditorState, key: string): void {
  const found = findOption(state, key);
  if (found) found.section.options = found.section.options.filter((o) => o.key !== key);
}

/** The hidden field parsePollForm reads: ids, keys, names, types and image choices, in on-screen order. */
export function structureJson(state: EditorState): string {
  return JSON.stringify({
    sections: state.sections.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      answer_type: s.answer_type,
      options: s.options.map((o) => ({
        id: o.id,
        key: o.key,
        name: o.name,
        image_path: o.image_path,
        remove_image: o.remove_image,
      })),
    })),
  });
}

/**
 * What the Preview draws (BR3.2): the editor as it is now, saved or not. A chosen file shows through its local
 * object URL; a removed image shows nothing; otherwise the stored image at preview size.
 */
export function previewView(
  state: EditorState,
  title: string,
  description: string,
  localUrls: ReadonlyMap<string, string>,
): PollView {
  return {
    title: title.trim() || 'Untitled poll',
    description: description.trim() || null,
    sections: state.sections.map((s) => ({
      name: s.name.trim() || 'Untitled section',
      answerType: isAnswerType(s.answer_type) ? s.answer_type : 'single',
      options: s.options.map((o) => ({
        name: o.name.trim() || 'Untitled option',
        imageUrl: localUrls.get(o.key) ?? (o.remove_image ? null : o.preview_url),
      })),
    })),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A stored instant as the value of a datetime-local input, in the browser's time zone. */
export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (browser time zone) as an ISO instant in UTC; '' for none or a bad value. */
export function localToIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// --- DOM -----------------------------------------------------------------------------------------------------

const FIELD =
  'rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-brand-primary';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text) node.textContent = text;
  return node;
}

/** The icon each editor action shows (BR8.1); paths are 24x24 strokes. */
export type PollIcon = 'up' | 'down' | 'trash' | 'plus';
const ICON_PATHS: Record<PollIcon, string[]> = {
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  down: ['M12 5v14', 'M19 12l-7 7-7-7'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  plus: ['M12 5v14', 'M5 12h14'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function iconSvg(icon: PollIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'h-4 w-4',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of ICON_PATHS[icon]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** An icon-only action button; refreshLabels gives it the name of what it acts on. */
function button(action: string, icon: PollIcon, kind = 'btn-neutral'): HTMLButtonElement {
  const node = el('button', { type: 'button', class: `btn ${kind} btn-sm !px-2`, 'data-action': action });
  node.append(iconSvg(icon));
  return node;
}

/** How a section is named in its buttons: "section Format", or "Section 2" while it has no name. */
export function sectionTarget(name: string, index: number): string {
  const trimmed = name.trim();
  return trimmed ? `section ${trimmed}` : `Section ${index + 1}`;
}

/** How an option is named in its buttons: "option Red", or "Option 2" while it has no name. */
export function optionTarget(name: string, index: number): string {
  const trimmed = name.trim();
  return trimmed ? `option ${trimmed}` : `Option ${index + 1}`;
}

/** The accessible name and hover text of each action button (FR8.2), e.g. "Move Section 2 up". */
export function actionLabel(action: string, target: string): string {
  switch (action) {
    case 'section-up':
    case 'option-up':
      return `Move ${target} up`;
    case 'section-down':
    case 'option-down':
      return `Move ${target} down`;
    case 'add-option':
      return `Add option to ${target}`;
    default:
      return `Remove ${target}`;
  }
}

function setActionLabel(scope: Element | null | undefined, action: string, target: string): void {
  const node = scope?.querySelector(`[data-action="${action}"]`);
  if (!node) return;
  const label = actionLabel(action, target);
  node.setAttribute('aria-label', label);
  node.setAttribute('title', label);
}

function errorLine(message: string | null): HTMLParagraphElement {
  const p = el('p', { class: 'text-sm text-brand-pink', 'data-error': '' }, message ?? '');
  p.hidden = !message;
  return p;
}

function optionRow(option: EditorOption): HTMLLIElement {
  const row = el('li', {
    class: 'flex flex-col gap-2 rounded-lg border border-white/10 p-3',
    'data-option-key': option.key,
  });
  const line = el('div', { class: 'flex flex-wrap items-center gap-2' });
  const name = el('input', {
    type: 'text',
    maxlength: '120',
    class: `${FIELD} min-w-0 flex-1`,
    'data-field': 'name',
    'aria-label': 'Option name',
  });
  name.value = option.name;
  line.append(name);
  if (option.thumb_url) {
    line.append(
      el('img', {
        src: option.thumb_url,
        alt: '',
        width: '40',
        height: '40',
        class: 'h-10 w-10 rounded-md object-cover',
      }),
    );
    const remove = el('label', { class: 'flex items-center gap-1.5 text-xs text-white/70' });
    const box = el('input', { type: 'checkbox', 'data-field': 'remove_image' });
    box.checked = option.remove_image;
    remove.append(box, document.createTextNode('Remove image'));
    line.append(remove);
  }
  const file = el('input', {
    type: 'file',
    name: `image_${option.key}`,
    accept: 'image/png,image/jpeg,image/webp',
    class: `${FIELD} max-w-full file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white`,
    'aria-label': 'Option image',
  });
  line.append(
    file,
    button('option-up', 'up'),
    button('option-down', 'down'),
    button('remove-option', 'trash', 'btn-danger'),
  );
  row.append(line, errorLine(option.error));
  return row;
}

function sectionCard(section: EditorSection): HTMLDivElement {
  const card = el('div', {
    class: 'flex flex-col gap-3 rounded-xl border border-white/10 bg-brand-ink p-4',
    'data-section-key': section.key,
  });
  const head = el('div', { class: 'flex flex-wrap items-end gap-3' });
  const nameLabel = el('label', { class: 'flex min-w-0 flex-1 flex-col gap-1.5 text-sm' });
  const name = el('input', { type: 'text', maxlength: '120', class: FIELD, 'data-field': 'name' });
  name.value = section.name;
  nameLabel.append(el('span', { class: 'text-white/70' }, 'Section name'), name);
  const typeLabel = el('label', { class: 'flex flex-col gap-1.5 text-sm' });
  const select = el('select', { class: FIELD, 'data-field': 'answer_type' });
  for (const [value, label] of Object.entries(ANSWER_TYPE_LABELS)) {
    const option = el('option', { value, class: 'bg-brand-ink text-white' }, label);
    option.selected = section.answer_type === value;
    select.append(option);
  }
  typeLabel.append(el('span', { class: 'text-white/70' }, 'Answer type'), select);
  head.append(nameLabel, typeLabel);
  const actions = el('div', { class: 'flex flex-wrap gap-2' });
  actions.append(
    button('add-option', 'plus'),
    button('section-up', 'up'),
    button('section-down', 'down'),
    button('remove-section', 'trash', 'btn-danger'),
  );
  card.append(
    head,
    errorLine(section.error),
    el('ol', { class: 'flex flex-col gap-2', 'data-options': '' }),
    actions,
  );
  section.options.forEach((o) => card.querySelector('[data-options]')!.append(optionRow(o)));
  return card;
}

/** Icon buttons name their item, so screen readers can tell them apart and hover shows the same text. */
function refreshLabels(root: HTMLElement, state: EditorState): void {
  state.sections.forEach((section, i) => {
    const card = root.querySelector<HTMLElement>(`[data-section-key="${section.key}"]`);
    if (!card) return;
    const target = sectionTarget(section.name, i);
    for (const action of ['add-option', 'section-up', 'section-down', 'remove-section']) {
      setActionLabel(card, action, target);
    }
    section.options.forEach((option, j) => {
      const row = card.querySelector<HTMLElement>(`[data-option-key="${option.key}"]`);
      const optionName = optionTarget(option.name, j);
      for (const action of ['option-up', 'option-down', 'remove-option'])
        setActionLabel(row, action, optionName);
    });
  });
}

/** Puts cards and rows in state order, reusing existing nodes so chosen files and focus survive a move. */
function render(root: HTMLElement, state: EditorState): void {
  const cards = new Map(
    [...root.querySelectorAll<HTMLElement>('[data-section-key]')].map((c) => [c.dataset.sectionKey!, c]),
  );
  const rows = new Map(
    [...root.querySelectorAll<HTMLElement>('[data-option-key]')].map((r) => [r.dataset.optionKey!, r]),
  );
  const keep = new Set<HTMLElement>();
  for (const section of state.sections) {
    const card = cards.get(section.key) ?? sectionCard(section);
    keep.add(card);
    root.append(card);
    const list = card.querySelector<HTMLElement>('[data-options]')!;
    for (const option of section.options) {
      const row = rows.get(option.key) ?? optionRow(option);
      keep.add(row);
      list.append(row);
    }
  }
  for (const node of [...cards.values(), ...rows.values()]) if (!keep.has(node)) node.remove();
  refreshLabels(root, state);
}

function readState(form: HTMLFormElement): EditorState | null {
  const data = form.querySelector('[data-poll-editor-state]')?.textContent;
  try {
    return data ? (JSON.parse(data) as EditorState) : null;
  } catch {
    return null;
  }
}

function initPollEditor(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-poll-editor]');
  const root = form?.querySelector<HTMLElement>('[data-poll-sections]');
  const structure = form?.querySelector<HTMLInputElement>('input[name="structure"]');
  if (!form || !root || !structure || form.dataset.pollEditorInit === 'true') return;
  const state = readState(form);
  if (!state) return;
  form.dataset.pollEditorInit = 'true';
  const localUrls = new Map<string, string>();
  const sync = () => (structure.value = structureJson(state));

  const closesLocal = form.querySelector<HTMLInputElement>('[data-poll-closes-local]');
  const closesIso = form.querySelector<HTMLInputElement>('input[name="closes_at"]');
  if (closesLocal && closesIso) {
    closesLocal.value = isoToLocal(closesIso.value);
    closesLocal.addEventListener('input', () => (closesIso.value = localToIso(closesLocal.value)));
  }

  root.addEventListener('input', (e) => onEdit(e.target));
  root.addEventListener('change', (e) => onEdit(e.target));
  function onEdit(target: EventTarget | null): void {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const row = target.closest<HTMLElement>('[data-option-key]');
    const card = target.closest<HTMLElement>('[data-section-key]');
    const field = target.dataset.field;
    if (row) {
      const found = findOption(state!, row.dataset.optionKey!);
      if (!found) return;
      if (field === 'name') found.option.name = target.value;
      if (field === 'remove_image' && target instanceof HTMLInputElement)
        found.option.remove_image = target.checked;
    } else if (card) {
      const section = state!.sections.find((s) => s.key === card.dataset.sectionKey);
      if (!section) return;
      if (field === 'name') section.name = target.value;
      if (field === 'answer_type' && isAnswerType(target.value)) section.answer_type = target.value;
    }
    refreshLabels(root!, state!);
    sync();
  }

  // A chosen image is shrunk in the browser and swapped into its input before the form can send it.
  const pending = new Map<string, Promise<void>>();
  const setPreview = (key: string, file: File | undefined) => {
    const old = localUrls.get(key);
    if (old) URL.revokeObjectURL(old);
    if (file) localUrls.set(key, URL.createObjectURL(file));
    else localUrls.delete(key);
  };
  root.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const key = input.closest<HTMLElement>('[data-option-key]')?.dataset.optionKey;
    if (!key) return;
    const chosen = input.files?.[0];
    setPreview(key, chosen);
    if (!chosen) return;
    const job = shrinkPollImage(chosen)
      .then((file) => {
        // Skip a result the admin has already replaced with another file.
        if (file === chosen || input.files?.[0] !== chosen) return;
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        setPreview(key, file);
      })
      .catch(() => undefined)
      .finally(() => {
        if (pending.get(key) === job) pending.delete(key);
      });
    pending.set(key, job);
  });

  const sizeMessage = form.querySelector<HTMLElement>('[data-poll-size-message]');
  const showSizeMessage = (text: string | null) => {
    if (!sizeMessage) return;
    sizeMessage.textContent = text ?? '';
    sizeMessage.hidden = !text;
  };
  let resubmitting = false;
  form.addEventListener('submit', async (e) => {
    sync();
    if (resubmitting) return;
    const waiting = [...pending.values()];
    if (waiting.length > 0) {
      e.preventDefault();
      showSizeMessage('Preparing the images…');
      await Promise.all(waiting);
    }
    const files = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')].map((i) => i.files?.[0]);
    const message = pollImagesBudgetMessage(files.reduce((sum, f) => sum + (f?.size ?? 0), 0));
    if (message) {
      e.preventDefault();
      showSizeMessage(message);
      return;
    }
    showSizeMessage(null);
    if (waiting.length > 0) {
      resubmitting = true;
      const submitter = e.submitter instanceof HTMLButtonElement ? e.submitter : undefined;
      form.requestSubmit(submitter);
    }
  });

  root.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!action) return;
    const optionKey = action.closest<HTMLElement>('[data-option-key]')?.dataset.optionKey;
    const sectionKey = action.closest<HTMLElement>('[data-section-key]')?.dataset.sectionKey ?? '';
    const name = action.dataset.action;
    if (name === 'add-option') addOption(state, sectionKey);
    else if (name === 'section-up' || name === 'section-down')
      moveSection(state, sectionKey, name === 'section-up' ? -1 : 1);
    else if (name === 'remove-section') removeSection(state, sectionKey);
    else if (optionKey && (name === 'option-up' || name === 'option-down'))
      moveOption(state, optionKey, name === 'option-up' ? -1 : 1);
    else if (optionKey && name === 'remove-option') removeOption(state, optionKey);
    render(root, state);
    sync();
    // A removed row takes its button with it; focus then falls back to the list.
    if (action.isConnected) action.focus();
    else root.focus();
  });

  form.querySelector('[data-poll-add-section]')?.addEventListener('click', () => {
    const section = addSection(state);
    render(root, state);
    sync();
    root
      .querySelector<HTMLInputElement>(`[data-section-key="${section.key}"] input[data-field="name"]`)
      ?.focus();
  });

  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-poll-preview-dialog]');
  const body = dialog?.querySelector<HTMLElement>('[data-poll-preview-body]');
  form.querySelector('[data-poll-preview]')?.addEventListener('click', () => {
    if (!dialog || !body) return;
    const title = form.querySelector<HTMLInputElement>('input[name="title"]')?.value ?? '';
    const description = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]')?.value ?? '';
    body.innerHTML = pollViewHtml(previewView(state, title, description, localUrls));
    dialog.showModal();
  });
  dialog?.querySelector('[data-poll-preview-close]')?.addEventListener('click', () => dialog.close());

  render(root, state);
  sync();
}

if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initPollEditor);
