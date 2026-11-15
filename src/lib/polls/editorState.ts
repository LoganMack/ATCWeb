/**
 * The poll editor's starting state, built on the server from a stored poll or from a form that came back with
 * errors, and handed to src/scripts/pollEditor.ts as JSON. Image URLs are resized here (NFR2).
 */
import { isPollImagePath } from './images';
import { TEXT_MAX_LENGTH_DEFAULT, isAnswerType, type AnswerType, type Poll } from './types';
import type { OptionMode, PollForm, PollFormError } from './validate';

export interface EditorOption {
  id: string | null;
  key: string;
  /** The Text mode name; kept while the row shows Circuits, so switching back loses nothing (BR6.1). */
  name: string;
  mode: OptionMode;
  /** The picked layout and its label, used while the row shows Circuits (BR6.3). */
  layout_id: string | null;
  layout_name: string;
  /** The stored path, kept unless the admin removes or replaces the image. */
  image_path: string | null;
  /** The stored image at editor thumbnail size, and at preview size. */
  thumb_url: string | null;
  preview_url: string | null;
  remove_image: boolean;
  error: string | null;
}

export interface EditorSection {
  id: string | null;
  key: string;
  name: string;
  answer_type: AnswerType | '';
  /** The Max length field as typed; only used while the answer type is Text (BR5.1). */
  text_max_length: string;
  options: EditorOption[];
  error: string | null;
}

export interface EditorState {
  sections: EditorSection[];
  /** The next number the script uses for new row keys, so a key is never reused in one editor. */
  next_key: number;
}

/** Builds an image's public URL at a width; the server passes pollImageUrl from src/lib/db/polls.ts. */
export type ImageUrlFor = (path: string | null, width: number) => string | null;

export const EDITOR_THUMB_WIDTH = 96;
export const PREVIEW_IMAGE_WIDTH = 320;

/** A blank editor: one Pick one section with two empty options. */
export function newEditorState(): EditorState {
  return {
    sections: [
      {
        id: null,
        key: 'k1',
        name: '',
        answer_type: 'single',
        text_max_length: String(TEXT_MAX_LENGTH_DEFAULT),
        error: null,
        options: [blankOption('k2'), blankOption('k3')],
      },
    ],
    next_key: 4,
  };
}

/** A new row starts in Circuits mode (BR6.1). */
export function blankOption(key: string): EditorOption {
  return {
    id: null,
    key,
    name: '',
    mode: 'circuits',
    layout_id: null,
    layout_name: '',
    image_path: null,
    thumb_url: null,
    preview_url: null,
    remove_image: false,
    error: null,
  };
}

/** A saved row opens in Circuits mode when it has a layout, otherwise in Text mode (BR6.5). */
export function editorStateFromPoll(poll: Poll, imageUrl: ImageUrlFor): EditorState {
  let n = 0;
  const sections = poll.sections.map((s) => ({
    id: s.id,
    key: `k${++n}`,
    name: s.name,
    answer_type: s.answer_type,
    text_max_length: String(s.text_max_length ?? TEXT_MAX_LENGTH_DEFAULT),
    error: null,
    options: s.options.map((o): EditorOption => ({
      id: o.id,
      key: `k${++n}`,
      name: o.name,
      mode: o.layout_id ? 'circuits' : 'text',
      layout_id: o.layout_id ?? null,
      layout_name: o.layout_id ? o.name : '',
      image_path: o.image_path,
      thumb_url: imageUrl(o.image_path, EDITOR_THUMB_WIDTH),
      preview_url: imageUrl(o.image_path, PREVIEW_IMAGE_WIDTH),
      remove_image: false,
      error: null,
    })),
  }));
  return { sections, next_key: n + 1 };
}

/**
 * The state of a form that came back with errors, so everything typed is kept (files are not: browsers never
 * refill a file input). Stored paths outside this poll's folder are dropped rather than shown.
 */
export function editorStateFromForm(
  form: PollForm,
  pollId: string | null,
  errors: PollFormError[],
  imageUrl: ImageUrlFor,
): EditorState {
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message ?? null;
  let highest = 0;
  const track = (key: string) => {
    const n = /^k(\d+)$/.exec(key);
    if (n) highest = Math.max(highest, Number(n[1]));
    return key;
  };
  const sections = form.sections.map((s) => ({
    id: s.id,
    key: track(s.key),
    name: s.name,
    answer_type: (isAnswerType(s.answerType) ? s.answerType : '') as AnswerType | '',
    text_max_length: s.textMaxLength || String(TEXT_MAX_LENGTH_DEFAULT),
    error: errorFor(`section:${s.key}`),
    options: s.options.map((o): EditorOption => {
      const path = pollId && o.imagePath && isPollImagePath(pollId, o.imagePath) ? o.imagePath : null;
      return {
        id: o.id,
        key: track(o.key),
        name: o.name,
        mode: o.mode,
        layout_id: o.layoutId,
        layout_name: o.layoutId ? o.name : '',
        image_path: path,
        thumb_url: imageUrl(path, EDITOR_THUMB_WIDTH),
        preview_url: imageUrl(path, PREVIEW_IMAGE_WIDTH),
        remove_image: path !== null && o.removeImage,
        error: errorFor(`option:${o.key}`),
      };
    }),
  }));
  return { sections, next_key: highest + 1 };
}
