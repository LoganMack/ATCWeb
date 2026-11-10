/** Polls (U2): the stored shapes (20261115120001_polls.sql) and the shape the shared renderer draws. */

export type AnswerType = 'single' | 'multiple' | 'stars';

export const ANSWER_TYPES: readonly AnswerType[] = ['single', 'multiple', 'stars'];

/** The editor's names for the answer types (FR1.4.1). */
export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  single: 'Pick one',
  multiple: 'Pick several',
  stars: 'Star rating',
};

export function isAnswerType(value: unknown): value is AnswerType {
  return typeof value === 'string' && (ANSWER_TYPES as readonly string[]).includes(value);
}

export type PollStatus = 'draft' | 'posted';

/** Closed is not stored: it is a posted poll whose closing date has passed (BR3.4). */
export type PollDisplayStatus = 'draft' | 'posted' | 'closed';

export interface PollOption {
  id: string;
  name: string;
  image_path: string | null;
  position: number;
}

export interface PollSection {
  id: string;
  name: string;
  answer_type: AnswerType;
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
    options: { name: string; imageUrl: string | null }[];
  }[];
}
