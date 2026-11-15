/**
 * The poll editor (Admin > Polls, new and edit pages): add, remove and reorder sections and options in the
 * browser, keep the hidden `structure` JSON in step, and open a Preview drawn with the public page's renderer
 * (polls BR1.4, BR3.2). Option rows pick a site layout (Circuits) or take a typed name and an uploaded image
 * (Text); a question can be the Text answer type with a max length (BR5.1, BR6.1-BR6.6). The state helpers are
 * pure and tested; the DOM part binds once per page load.
 */
import { pollViewHtml } from '../lib/polls/view';
import {
  ANSWER_TYPE_LABELS,
  TEXT_MAX_LENGTH_DEFAULT,
  TEXT_MAX_LENGTH_MAX,
  TEXT_MAX_LENGTH_MIN,
  isAnswerType,
  type LayoutChoice,
  type PollView,
} from '../lib/polls/types';
import {
  blankOption,
  type EditorOption,
  type EditorSection,
  type EditorState,
} from '../lib/polls/editorState';
import type { OptionMode } from '../lib/polls/validate';
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
    text_max_length: String(TEXT_MAX_LENGTH_DEFAULT),
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

/** The name an option saves and shows: the picked layout's label in Circuits mode, else the typed name. */
export function effectiveName(option: EditorOption): string {
  return option.mode === 'circuits' && option.layout_id ? option.layout_name : option.name;
}

/** Switches a row between Circuits and Text (BR6.1); each mode keeps its own value, so switching back loses nothing. */
export function setOptionMode(state: EditorState, key: string, mode: OptionMode): boolean {
  const found = findOption(state, key);
  if (!found) return false;
  found.option.mode = mode;
  return true;
}

/**
 * Picks a layout for a Circuits row (BR6.2, BR6.3): the label becomes the option's name. A stored upload is
 * left alone: a Circuits row already saves no image, and switching back to Text should bring the upload back.
 * Null clears the pick.
 */
export function pickLayout(state: EditorState, key: string, layout: LayoutChoice | null): boolean {
  const found = findOption(state, key);
  if (!found) return false;
  const option = found.option;
  option.mode = 'circuits';
  option.layout_id = layout?.id ?? null;
  option.layout_name = layout?.label ?? '';
  return true;
}

/** The keys of Circuits rows that repeat a layout an earlier row in the same question already picked (BR6.4). */
export function duplicateLayoutKeys(section: EditorSection): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const option of section.options) {
    if (option.mode !== 'circuits' || !option.layout_id) continue;
    if (seen.has(option.layout_id)) duplicates.add(option.key);
    seen.add(option.layout_id);
  }
  return duplicates;
}

export const DUPLICATE_LAYOUT_MESSAGE = 'This circuit is already an option in this section.';

/** The hidden field parsePollForm reads: ids, keys, names, types, modes and image choices, in on-screen order. */
export function structureJson(state: EditorState): string {
  return JSON.stringify({
    sections: state.sections.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      answer_type: s.answer_type,
      text_max_length: s.text_max_length,
      options: s.options.map((o) => ({
        id: o.id,
        key: o.key,
        name: effectiveName(o),
        mode: o.mode,
        layout_id: o.mode === 'circuits' ? o.layout_id : null,
        image_path: o.image_path,
        remove_image: o.remove_image,
      })),
    })),
  });
}

function previewMaxLength(raw: string): number {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= TEXT_MAX_LENGTH_MIN && n <= TEXT_MAX_LENGTH_MAX
    ? n
    : TEXT_MAX_LENGTH_DEFAULT;
}

/**
 * What the Preview draws (BR3.2): the editor as it is now, saved or not. A Circuits row shows its layout's image;
 * a chosen file shows through its local object URL; a removed image shows nothing; otherwise the stored image
 * at preview size. A Text question shows its answer box and no options.
 */
export function previewView(
  state: EditorState,
  title: string,
  description: string,
  localUrls: ReadonlyMap<string, string>,
  layoutImages: ReadonlyMap<string, string | null> = new Map(),
): PollView {
  return {
    title: title.trim() || 'Untitled poll',
    description: description.trim() || null,
    sections: state.sections.map((s) => {
      const answerType = isAnswerType(s.answer_type) ? s.answer_type : 'single';
      return {
        name: s.name.trim() || 'Untitled section',
        answerType,
        maxLength: answerType === 'text' ? previewMaxLength(s.text_max_length) : null,
        options:
          answerType === 'text'
            ? []
            : s.options.map((o) => ({
                name: effectiveName(o).trim() || 'Untitled option',
                imageUrl:
                  o.mode === 'circuits'
                    ? o.layout_id
                      ? (layoutImages.get(o.layout_id) ?? null)
                      : null
                    : (localUrls.get(o.key) ?? (o.remove_image ? null : o.preview_url)),
              })),
      };
    }),
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
export type PollIcon = 'up' | 'down' | 'trash' | 'plus' | 'flag' | 'type' | 'image';
const ICON_PATHS: Record<PollIcon, string[]> = {
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  down: ['M12 5v14', 'M19 12l-7 7-7-7'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  plus: ['M12 5v14', 'M5 12h14'],
  flag: ['M4 22V4', 'M4 4h13l-2 4 2 4H4'],
  type: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
  image: ['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 8.5h.01'],
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
    case 'option-image':
      return `Image for ${target}`;
    default:
      return `Remove ${target}`;
  }
}

/**
 * The mode toggle's name and tooltip (BR6.1): the label says what pressing it does, the tooltip the mode the
 * row is in now, and aria-pressed is true while the row uses a circuit.
 */
export function modeToggleLabels(mode: OptionMode): { label: string; title: string; pressed: string } {
  return mode === 'circuits'
    ? {
        label: 'Use text',
        title: 'Circuit option: picks a site layout. Press to type a name instead.',
        pressed: 'true',
      }
    : {
        label: 'Use circuit',
        title: 'Text option: a typed name and image. Press to pick a circuit instead.',
        pressed: 'false',
      };
}

function setActionLabel(scope: Element | null | undefined, action: string, target: string): void {
  const node = scope?.querySelector(`[data-action="${action}"]`);
  if (!node) return;
  const label = actionLabel(action, target);
  node.setAttribute('aria-label', label);
  node.setAttribute('title', label);
}

function errorLine(message: string | null, attr = 'data-error'): HTMLParagraphElement {
  const p = el('p', { class: 'text-sm text-brand-pink', [attr]: '' }, message ?? '');
  p.hidden = !message;
  return p;
}

function layoutSelect(option: EditorOption, layouts: readonly LayoutChoice[]): HTMLSelectElement {
  const select = el('select', {
    class: `${FIELD} min-w-0 flex-1`,
    'data-field': 'layout_id',
    'aria-label': 'Circuit',
    'data-testid': 'poll-option-layout',
  });
  select.append(el('option', { value: '', class: 'bg-brand-ink text-white' }, 'Choose a circuit…'));
  for (const layout of layouts) {
    const node = el('option', { value: layout.id, class: 'bg-brand-ink text-white' }, layout.label);
    node.selected = option.layout_id === layout.id;
    select.append(node);
  }
  return select;
}

/** The popup that holds a Text row's unchanged upload flow (BR6.6): stored image, Remove, file input, Close. */
function imageDialog(option: EditorOption): HTMLDialogElement {
  const dialog = el('dialog', {
    class:
      'w-full max-w-md rounded-xl border border-white/10 bg-brand-ink p-0 text-white backdrop:bg-black/60',
    'aria-label': 'Option image',
    'data-option-image-dialog': '',
    'data-testid': 'poll-option-image-dialog',
  });
  const body = el('div', { class: 'flex flex-col gap-3 p-5' });
  body.append(el('p', { class: 'text-xs uppercase tracking-wide text-white/50' }, 'Option image'));
  if (option.thumb_url) {
    const stored = el('div', { class: 'flex items-center gap-3' });
    stored.append(
      el('img', {
        src: option.thumb_url,
        alt: '',
        width: '64',
        height: '64',
        class: 'h-16 w-16 rounded-md object-cover',
      }),
    );
    const remove = el('label', { class: 'flex items-center gap-1.5 text-xs text-white/70' });
    const box = el('input', {
      type: 'checkbox',
      'data-field': 'remove_image',
      'data-testid': 'poll-option-remove-image',
    });
    box.checked = option.remove_image;
    remove.append(box, document.createTextNode('Remove image'));
    stored.append(remove);
    body.append(stored);
  }
  body.append(
    el('input', {
      type: 'file',
      name: `image_${option.key}`,
      accept: 'image/png,image/jpeg,image/webp',
      class: `${FIELD} max-w-full file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-white`,
      'aria-label': 'Upload image',
      'data-testid': 'poll-option-file',
    }),
  );
  const actions = el('div', { class: 'flex justify-end' });
  actions.append(
    el(
      'button',
      {
        type: 'button',
        class: 'btn btn-neutral',
        'data-image-dialog-close': '',
        'data-testid': 'poll-option-image-close',
      },
      'Close',
    ),
  );
  body.append(actions);
  dialog.append(body);
  return dialog;
}

function optionRow(option: EditorOption, layouts: readonly LayoutChoice[]): HTMLLIElement {
  const row = el('li', {
    class: 'flex flex-col gap-2 rounded-lg border border-white/10 p-3',
    'data-option-key': option.key,
    'data-mode': option.mode,
  });
  const line = el('div', { class: 'flex flex-wrap items-center gap-2' });
  const toggle = button('option-mode', option.mode === 'circuits' ? 'flag' : 'type');
  toggle.dataset.testid = 'poll-option-mode';
  const thumb = el('img', {
    alt: '',
    width: '40',
    height: '40',
    class: 'h-10 w-10 rounded-md object-contain',
    'data-layout-thumb': '',
  });
  const name = el('input', {
    type: 'text',
    maxlength: '120',
    class: `${FIELD} min-w-0 flex-1`,
    'data-field': 'name',
    'aria-label': 'Option name',
    'data-testid': 'poll-option-name',
  });
  name.value = option.name;
  const image = button('option-image', 'image');
  image.dataset.testid = 'poll-option-image';
  line.append(
    toggle,
    layoutSelect(option, layouts),
    thumb,
    name,
    image,
    button('option-up', 'up'),
    button('option-down', 'down'),
    button('remove-option', 'trash', 'btn-danger'),
  );
  row.append(line, errorLine(option.error), errorLine(null, 'data-duplicate-error'), imageDialog(option));
  return row;
}

/** Shows the controls of the row's mode; a Circuits row sends no file (BR6.3). */
function applyRowMode(
  row: HTMLElement,
  option: EditorOption,
  layouts: ReadonlyMap<string, LayoutChoice>,
): void {
  const circuits = option.mode === 'circuits';
  row.dataset.mode = option.mode;
  row.dataset.layoutId = option.layout_id ?? '';
  row.dataset.imagePath = option.image_path ?? '';
  const toggle = row.querySelector<HTMLButtonElement>('[data-action="option-mode"]');
  if (toggle) {
    const labels = modeToggleLabels(option.mode);
    toggle.setAttribute('aria-label', labels.label);
    toggle.setAttribute('title', labels.title);
    toggle.setAttribute('aria-pressed', labels.pressed);
    toggle.replaceChildren(iconSvg(circuits ? 'flag' : 'type'));
  }
  const select = row.querySelector<HTMLSelectElement>('[data-field="layout_id"]');
  if (select) select.hidden = !circuits;
  const thumb = row.querySelector<HTMLImageElement>('[data-layout-thumb]');
  const thumbUrl = circuits && option.layout_id ? (layouts.get(option.layout_id)?.imageUrl ?? null) : null;
  if (thumb) {
    thumb.hidden = !thumbUrl;
    if (thumbUrl) thumb.src = thumbUrl;
    else thumb.removeAttribute('src');
  }
  const name = row.querySelector<HTMLInputElement>('input[data-field="name"]');
  if (name) name.hidden = circuits;
  const image = row.querySelector<HTMLButtonElement>('[data-action="option-image"]');
  if (image) image.hidden = circuits;
  const file = row.querySelector<HTMLInputElement>('input[type="file"]');
  if (file) {
    file.disabled = circuits;
    if (circuits) file.value = '';
  }
}

function sectionCard(section: EditorSection, layouts: readonly LayoutChoice[]): HTMLDivElement {
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
  const select = el('select', {
    class: FIELD,
    'data-field': 'answer_type',
    'data-testid': 'poll-section-type',
  });
  for (const [value, label] of Object.entries(ANSWER_TYPE_LABELS)) {
    const option = el('option', { value, class: 'bg-brand-ink text-white' }, label);
    option.selected = section.answer_type === value;
    select.append(option);
  }
  typeLabel.append(el('span', { class: 'text-white/70' }, 'Answer type'), select);
  head.append(nameLabel, typeLabel);
  // The Text type's Max length (BR5.1): shown instead of the options while the type is Text.
  const maxLabel = el('label', { class: 'flex flex-col gap-1.5 text-sm', 'data-text-only': '' });
  const max = el('input', {
    type: 'number',
    min: String(TEXT_MAX_LENGTH_MIN),
    max: String(TEXT_MAX_LENGTH_MAX),
    step: '1',
    inputmode: 'numeric',
    class: `${FIELD} w-32`,
    'data-field': 'text_max_length',
    'data-testid': 'poll-section-max-length',
  });
  max.value = section.text_max_length;
  maxLabel.append(
    el(
      'span',
      { class: 'text-white/70' },
      `Max length (${TEXT_MAX_LENGTH_MIN} to ${TEXT_MAX_LENGTH_MAX} characters)`,
    ),
    max,
  );
  const add = button('add-option', 'plus');
  add.dataset.choiceOnly = '';
  const actions = el('div', { class: 'flex flex-wrap gap-2' });
  actions.append(
    add,
    button('section-up', 'up'),
    button('section-down', 'down'),
    button('remove-section', 'trash', 'btn-danger'),
  );
  card.append(
    head,
    maxLabel,
    errorLine(section.error),
    el('ol', { class: 'flex flex-col gap-2', 'data-options': '', 'data-choice-only': '' }),
    actions,
  );
  section.options.forEach((o) => card.querySelector('[data-options]')!.append(optionRow(o, layouts)));
  return card;
}

/** A Text question hides its options and shows Max length; the other types the reverse (BR5.2). */
function applySectionType(card: HTMLElement, section: EditorSection): void {
  const isText = section.answer_type === 'text';
  card.dataset.answerType = section.answer_type;
  card.querySelectorAll<HTMLElement>('[data-text-only]').forEach((n) => (n.hidden = !isText));
  card.querySelectorAll<HTMLElement>('[data-choice-only]').forEach((n) => (n.hidden = isText));
}

/** Icon buttons name their item, so screen readers can tell them apart and hover shows the same text. */
function refreshLabels(
  root: HTMLElement,
  state: EditorState,
  layouts: ReadonlyMap<string, LayoutChoice>,
): void {
  state.sections.forEach((section, i) => {
    const card = root.querySelector<HTMLElement>(`[data-section-key="${section.key}"]`);
    if (!card) return;
    applySectionType(card, section);
    const target = sectionTarget(section.name, i);
    for (const action of ['add-option', 'section-up', 'section-down', 'remove-section']) {
      setActionLabel(card, action, target);
    }
    const duplicates = duplicateLayoutKeys(section);
    section.options.forEach((option, j) => {
      const row = card.querySelector<HTMLElement>(`[data-option-key="${option.key}"]`);
      if (!row) return;
      applyRowMode(row, option, layouts);
      const optionName = optionTarget(effectiveName(option), j);
      for (const action of ['option-up', 'option-down', 'remove-option', 'option-image'])
        setActionLabel(row, action, optionName);
      const duplicate = row.querySelector<HTMLElement>('[data-duplicate-error]');
      if (duplicate) {
        duplicate.textContent = duplicates.has(option.key) ? DUPLICATE_LAYOUT_MESSAGE : '';
        duplicate.hidden = !duplicates.has(option.key);
      }
    });
  });
}

/** Puts cards and rows in state order, reusing existing nodes so chosen files and focus survive a move. */
function render(
  root: HTMLElement,
  state: EditorState,
  layoutList: readonly LayoutChoice[],
  layouts: ReadonlyMap<string, LayoutChoice>,
): void {
  const cards = new Map(
    [...root.querySelectorAll<HTMLElement>('[data-section-key]')].map((c) => [c.dataset.sectionKey!, c]),
  );
  const rows = new Map(
    [...root.querySelectorAll<HTMLElement>('[data-option-key]')].map((r) => [r.dataset.optionKey!, r]),
  );
  const keep = new Set<HTMLElement>();
  for (const section of state.sections) {
    const card = cards.get(section.key) ?? sectionCard(section, layoutList);
    keep.add(card);
    root.append(card);
    const list = card.querySelector<HTMLElement>('[data-options]')!;
    for (const option of section.options) {
      const row = rows.get(option.key) ?? optionRow(option, layoutList);
      keep.add(row);
      list.append(row);
    }
  }
  for (const node of [...cards.values(), ...rows.values()]) if (!keep.has(node)) node.remove();
  refreshLabels(root, state, layouts);
}

function readJson<T>(form: HTMLFormElement, selector: string): T | null {
  const data = form.querySelector(selector)?.textContent;
  try {
    return data ? (JSON.parse(data) as T) : null;
  } catch {
    return null;
  }
}

function initPollEditor(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-poll-editor]');
  const root = form?.querySelector<HTMLElement>('[data-poll-sections]');
  const structure = form?.querySelector<HTMLInputElement>('input[name="structure"]');
  if (!form || !root || !structure || form.dataset.pollEditorInit === 'true') return;
  const state = readJson<EditorState>(form, '[data-poll-editor-state]');
  if (!state) return;
  form.dataset.pollEditorInit = 'true';
  const layoutList = readJson<LayoutChoice[]>(form, '[data-poll-layouts]') ?? [];
  const layouts = new Map(layoutList.map((l) => [l.id, l]));
  const layoutImages = new Map(layoutList.map((l) => [l.id, l.imageUrl]));
  const localUrls = new Map<string, string>();
  const sync = () => (structure.value = structureJson(state));
  const redraw = () => {
    render(root, state, layoutList, layouts);
    sync();
  };

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
      if (field === 'layout_id') {
        pickLayout(state!, found.option.key, layouts.get(target.value) ?? null);
        // A picked layout replaces any upload, including one chosen but not yet saved.
        const file = row.querySelector<HTMLInputElement>('input[type="file"]');
        if (file) file.value = '';
        setPreview(found.option.key, undefined);
        const box = row.querySelector<HTMLInputElement>('[data-field="remove_image"]');
        if (box) box.checked = found.option.remove_image;
      }
    } else if (card) {
      const section = state!.sections.find((s) => s.key === card.dataset.sectionKey);
      if (!section) return;
      if (field === 'name') section.name = target.value;
      if (field === 'answer_type' && isAnswerType(target.value)) section.answer_type = target.value;
      if (field === 'text_max_length') section.text_max_length = target.value;
    }
    refreshLabels(root!, state!, layouts);
    sync();
  }

  // A chosen image is shrunk in the browser and swapped into its input before the form can send it.
  const pending = new Map<string, Promise<void>>();
  function setPreview(key: string, file: File | undefined): void {
    const old = localUrls.get(key);
    if (old) URL.revokeObjectURL(old);
    if (file) localUrls.set(key, URL.createObjectURL(file));
    else localUrls.delete(key);
  }
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
    const files = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]:not(:disabled)')].map(
      (i) => i.files?.[0],
    );
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
    const target = e.target as HTMLElement;
    // The image popup's Close returns focus to the row's image button (BR6.6).
    const close = target.closest<HTMLElement>('[data-image-dialog-close]');
    if (close) {
      close.closest('dialog')?.close();
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]');
    if (!action) return;
    const row = action.closest<HTMLElement>('[data-option-key]');
    const optionKey = row?.dataset.optionKey;
    const sectionKey = action.closest<HTMLElement>('[data-section-key]')?.dataset.sectionKey ?? '';
    const name = action.dataset.action;
    if (optionKey && name === 'option-image') {
      const dialog = row!.querySelector<HTMLDialogElement>('dialog[data-option-image-dialog]');
      if (dialog && !dialog.dataset.bound) {
        dialog.dataset.bound = 'true';
        dialog.addEventListener('close', () => action.focus());
      }
      dialog?.showModal();
      return;
    }
    if (name === 'add-option') addOption(state, sectionKey);
    else if (name === 'section-up' || name === 'section-down')
      moveSection(state, sectionKey, name === 'section-up' ? -1 : 1);
    else if (name === 'remove-section') removeSection(state, sectionKey);
    else if (optionKey && (name === 'option-up' || name === 'option-down'))
      moveOption(state, optionKey, name === 'option-up' ? -1 : 1);
    else if (optionKey && name === 'remove-option') removeOption(state, optionKey);
    else if (optionKey && name === 'option-mode') {
      const found = findOption(state, optionKey);
      if (found) {
        setOptionMode(state, optionKey, found.option.mode === 'circuits' ? 'text' : 'circuits');
        if (found.option.mode === 'circuits') setPreview(optionKey, undefined);
      }
    }
    redraw();
    // A removed row takes its button with it; focus then falls back to the list.
    if (action.isConnected) action.focus();
    else root.focus();
  });

  form.querySelector('[data-poll-add-section]')?.addEventListener('click', () => {
    const section = addSection(state);
    redraw();
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
    body.innerHTML = pollViewHtml(previewView(state, title, description, localUrls, layoutImages));
    dialog.showModal();
  });
  dialog?.querySelector('[data-poll-preview-close]')?.addEventListener('click', () => dialog.close());

  redraw();
}

if (typeof document !== 'undefined') document.addEventListener('astro:page-load', initPollEditor);
