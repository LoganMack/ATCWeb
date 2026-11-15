/**
 * Polls (U2): the stored shapes (20261115120001_polls.sql, 20261118120000_records_text_polls.sql) and the
 * shape the shared renderer draws.
 */

export type AnswerType = 'single' | 'multiple' | 'stars' | 'text';

export const ANSWER_TYPES: readonly AnswerType[] = ['single', 'multiple', 'stars', 'text'];

/** The editor's names for the answer types (FR1.4.1, FR5.1). */
export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  single: 'Pick one',
  multiple: 'Pick several',
  stars: 'Star rating',
  text: 'Text',
};

export function isAnswerType(value: unknown): value is AnswerType {
  return typeof value === 'string' && (ANSWER_TYPES as readonly string[]).includes(value);
}

/** A Text question's answer length: 1 to 500 characters, 200 when the admin picks Text (BR5.1). */
export const TEXT_MAX_LENGTH_MIN = 1;
export const TEXT_MAX_LENGTH_MAX = 500;
export const TEXT_MAX_LENGTH_DEFAULT = 200;

export type PollStatus = 'draft' | 'posted';

/** Closed is not stored: it is a posted poll whose closing date has passed (BR3.4). */
export type PollDisplayStatus = 'draft' | 'posted' | 'closed';

export interface PollOption {
  id: string;
  name: string;
  image_path: string | null;
  /** A Circuits pick (BR6.3); its image is the layout's own. Null for a Text option or a deleted layout. */
  layout_id: string | null;
  position: number;
}

export interface PollSection {
  id: string;
  name: string;
  answer_type: AnswerType;
  /** Set exactly when answer_type is text (BR5.1). */
  text_max_length: number | null;
  position: number;
  options: PollOption[];
}

export interface Poll {
  id: string;
  title: string;
  description: string | null;
  closes_at: string | null;
  is_schedule_vote: boolean;
  status: PollStatus;
  posted_at: string | null;
  first_posted_at: string | null;
  created_at: string;
  /** Sent back unchanged with a save, so a stale editor is refused (BR5.5). Never parsed into a Date. */
  updated_at: string;
  sections: PollSection[];
}

/** What pollViewHtml draws: the public page and the editor's preview build the same shape (FR1.8). */
export interface PollView {
  title: string;
  description: string | null;
  sections: {
    name: string;
    answerType: AnswerType;
    /** A Text question's maxlength; absent or null for the other types. */
    maxLength?: number | null;
    options: { name: string; imageUrl: string | null }[];
  }[];
}

/** One entry of the editor's Circuits dropdown (BR6.2). */
export interface LayoutChoice {
  id: string;
  label: string;
  imageUrl: string | null;
}
