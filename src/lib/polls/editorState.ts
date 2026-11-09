/**
 * The poll editor's starting state, built on the server from a stored poll or from a form that came back with
 * errors, and handed to src/scripts/pollEditor.ts as JSON. Image URLs are resized here (NFR2).
 */
import { isPollImagePath } from './images';
import type { AnswerType, Poll } from './types';
import type { PollForm, PollFormError } from './validate';

export interface EditorOption {
  id: string | null;
  key: string;
  name: string;
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
        error: null,
        options: [blankOption('k2'), blankOption('k3')],
      },
    ],
    next_key: 4,
  };
}

export function blankOption(key: string): EditorOption {
  return { id: null, key, name: '', image_path: null, thumb_url: null, preview_url: null, remove_image: false, error: null };
}

export function editorStateFromPoll(poll: Poll, imageUrl: ImageUrlFor): EditorState {
  let n = 0;
  const sections = poll.sections.map((s) => ({
    id: s.id,
    key: `k${++n}`,
    name: s.name,
    answer_type: s.answer_type,
    error: null,
    options: s.options.map((o) => ({
      id: o.id,
      key: `k${++n}`,
      name: o.name,
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
    answer_type: (['single', 'multiple', 'stars'].includes(s.answerType) ? s.answerType : '') as AnswerType | '',
    error: errorFor(`section:${s.key}`),
    options: s.options.map((o) => {
      const path = pollId && o.imagePath && isPollImagePath(pollId, o.imagePath) ? o.imagePath : null;
      return {
        id: o.id,
        key: track(o.key),
        name: o.name,
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
