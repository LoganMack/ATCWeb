/**
 * The poll editor's form, read once on the server (BR1.1-BR1.4, BR2.4, BR4.1). The database repeats every
 * rule in save_poll; these checks give field-level messages and keep a bad save from uploading anything.
 */
import { ANSWER_TYPE_LABELS, isAnswerType, type AnswerType } from './types';
import { POLL_IMAGE_EXTENSIONS } from './images';

export const POLL_TITLE_MAX = 120;
export const POLL_DESCRIPTION_MAX = 2000;
export const POLL_SECTIONS_MIN = 1;
export const POLL_SECTIONS_MAX = 20;
export const POLL_NAME_MAX = 120;
export const POLL_OPTIONS_MAX = 30;
/** Pick one and Pick several need two options; a Star rating can rate one thing (BR1.3). */
export const POLL_OPTIONS_MIN: Record<AnswerType, number> = { single: 2, multiple: 2, stars: 1 };
export const POLL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** New image files one save may carry, which bounds the Worker's multipart parse (Limits and costs). */
export const POLL_NEW_IMAGES_MAX = 6;

export interface PollFormOption {
  id: string | null;
  /** The editor's key for this row; the option's file input is named `image_<key>`. */
  key: string;
  name: string;
  imagePath: string | null;
  removeImage: boolean;
  file: File | null;
}

export interface PollFormSection {
  id: string | null;
  key: string;
  name: string;
  answerType: string;
  options: PollFormOption[];
}

export interface PollForm {
  title: string;
  description: string;
  /** ISO time in UTC, filled in the browser from the local date-time input; empty for none. */
  closesAt: string;
  isScheduleVote: boolean;
  expectedUpdatedAt: string;
  sections: PollFormSection[];
}

export interface PollFormError {
  /** `title`, `description`, `closes_at`, `sections`, `images`, `section:<key>` or `option:<key>`. */
  field: string;
  message: string;
}

/** The payload save_poll takes (its p_poll argument). */
export interface PollSavePayload {
  title: string;
  description: string | null;
  closes_at: string | null;
  is_schedule_vote: boolean;
  sections: {
    id: string | null;
    name: string;
    answer_type: AnswerType;
    options: { id: string | null; name: string; image_path: string | null }[];
  }[];
}

type FormLike = { get(name: string): FormDataEntryValue | null };

/** Characters as the database's char_length counts them (code points, not UTF-16 units). */
export function charLength(text: string): number {
  return [...text].length;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function fileFor(form: FormLike, key: string): File | null {
  const value = form.get(`image_${key}`);
  return value instanceof File && value.size > 0 ? value : null;
}

/** The hidden `structure` JSON the editor script keeps in sync; anything malformed reads as no sections. */
function readSections(form: FormLike): PollFormSection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str(form.get('structure')) || '{}');
  } catch {
    return [];
  }
  const sections = (parsed as { sections?: unknown })?.sections;
  if (!Array.isArray(sections)) return [];
  return sections.slice(0, POLL_SECTIONS_MAX + 1).map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const key = KEY_PATTERN.test(str(s.key)) ? str(s.key) : `s${i}`;
    const options = Array.isArray(s.options) ? s.options.slice(0, POLL_OPTIONS_MAX + 1) : [];
    return {
      id: idOrNull(s.id),
      key,
      name: str(s.name),
      answerType: str(s.answer_type),
      options: options.map((rawOption, j) => {
        const o = (rawOption ?? {}) as Record<string, unknown>;
        const optionKey = KEY_PATTERN.test(str(o.key)) ? str(o.key) : `${key}o${j}`;
        return {
          id: idOrNull(o.id),
          key: optionKey,
          name: str(o.name),
          imagePath: str(o.image_path) || null,
          removeImage: o.remove_image === true,
          file: fileFor(form, optionKey),
        };
      }),
    };
  });
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function checkPoll(form: PollForm, existingClosesAt: string | null, now: Date): PollFormError[] {
  const errors: PollFormError[] = [];
  const title = form.title.trim();
  if (charLength(title) < 1 || charLength(title) > POLL_TITLE_MAX) {
    errors.push({ field: 'title', message: `The title must be 1 to ${POLL_TITLE_MAX} characters.` });
  }
  if (charLength(form.description.trim()) > POLL_DESCRIPTION_MAX) {
    errors.push({
      field: 'description',
      message: `The description can be at most ${POLL_DESCRIPTION_MAX.toLocaleString('en-US')} characters.`,
    });
  }
  if (form.closesAt) {
    const closes = new Date(form.closesAt).getTime();
    if (!Number.isFinite(closes)) {
      errors.push({ field: 'closes_at', message: 'The closing date is not a valid date and time.' });
    } else if (!sameInstant(form.closesAt, existingClosesAt) && closes <= now.getTime()) {
      errors.push({ field: 'closes_at', message: 'The closing date must be in the future.' });
    }
  }
  if (form.sections.length < POLL_SECTIONS_MIN || form.sections.length > POLL_SECTIONS_MAX) {
    errors.push({ field: 'sections', message: `A poll needs 1 to ${POLL_SECTIONS_MAX} sections.` });
  }
  return errors;
}

function checkSection(section: PollFormSection, n: number): PollFormError[] {
  const errors: PollFormError[] = [];
  const field = `section:${section.key}`;
  const name = section.name.trim();
  if (charLength(name) < 1 || charLength(name) > POLL_NAME_MAX) {
    errors.push({ field, message: `Section ${n}: the name must be 1 to ${POLL_NAME_MAX} characters.` });
  }
  if (!isAnswerType(section.answerType)) {
    errors.push({ field, message: `Section ${n}: choose an answer type.` });
    return errors;
  }
  const min = POLL_OPTIONS_MIN[section.answerType];
  if (section.options.length < min || section.options.length > POLL_OPTIONS_MAX) {
    errors.push({
      field,
      message: `Section ${n}: ${ANSWER_TYPE_LABELS[section.answerType]} needs ${min} to ${POLL_OPTIONS_MAX} options.`,
    });
  }
  const seen = new Set<string>();
  section.options.forEach((option, j) => {
    const optionName = option.name.trim();
    const optionField = `option:${option.key}`;
    if (charLength(optionName) < 1 || charLength(optionName) > POLL_NAME_MAX) {
      errors.push({
        field: optionField,
        message: `Section ${n}, option ${j + 1}: the name must be 1 to ${POLL_NAME_MAX} characters.`,
      });
    } else if (seen.has(optionName.toLowerCase())) {
      errors.push({
        field: optionField,
        message: `Section ${n}, option ${j + 1}: "${optionName}" is already an option in this section.`,
      });
    }
    seen.add(optionName.toLowerCase());
    if (option.file && !POLL_IMAGE_EXTENSIONS[option.file.type]) {
      errors.push({
        field: optionField,
        message: `Section ${n}, option ${j + 1}: the image must be a PNG, JPEG or WebP file.`,
      });
    } else if (option.file && option.file.size > POLL_IMAGE_MAX_BYTES) {
      errors.push({
        field: optionField,
        message: `Section ${n}, option ${j + 1}: the image must be 5 MB or smaller.`,
      });
    }
  });
  return errors;
}

/**
 * Reads the editor's fields into a typed form and lists every problem (empty when the form can be saved).
 * `existingClosesAt` is the stored closing date: an unchanged one that has passed is kept (BR2.4).
 */
export function parsePollForm(
  data: FormLike,
  existingClosesAt: string | null,
  now: Date = new Date(),
): { form: PollForm; errors: PollFormError[] } {
  const form: PollForm = {
    title: str(data.get('title')),
    description: str(data.get('description')),
    closesAt: str(data.get('closes_at')).trim(),
    isScheduleVote: data.get('is_schedule_vote') !== null,
    expectedUpdatedAt: str(data.get('updated_at')),
    sections: readSections(data),
  };
  const errors = checkPoll(form, existingClosesAt, now);
  form.sections.forEach((section, i) => errors.push(...checkSection(section, i + 1)));
  const newImages = form.sections.flatMap((s) => s.options).filter((o) => o.file).length;
  if (newImages > POLL_NEW_IMAGES_MAX) {
    errors.push({
      field: 'images',
      message: `One save can carry at most ${POLL_NEW_IMAGES_MAX} new images; save the rest in a second save.`,
    });
  }
  return { form, errors };
}

/**
 * The save_poll payload: new uploads (by option key) win, a removed image is null, otherwise the stored path.
 * Only call it on a form parsePollForm passed, so every answer type is valid.
 */
export function pollSavePayload(form: PollForm, uploaded: ReadonlyMap<string, string>): PollSavePayload {
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    closes_at: form.closesAt || null,
    is_schedule_vote: form.isScheduleVote,
    sections: form.sections.map((s) => ({
      id: s.id,
      name: s.name.trim(),
      answer_type: s.answerType as AnswerType,
      options: s.options.map((o) => ({
        id: o.id,
        name: o.name.trim(),
        image_path: uploaded.get(o.key) ?? (o.removeImage ? null : o.imagePath),
      })),
    })),
  };
}
