/**
 * Polls data access (U2; 20261115120001_polls.sql). Reads go through Row Level Security; every write is one
 * of the four SECURITY DEFINER functions, which refuse anyone but a full admin. Their stable error messages
 * are mapped here to the text the admin screens show.
 */
import { restGet, restGetAuthed, writeHeaders, type SupabaseEnv } from './client';
import { resizedImageUrl } from './drivers';
import { pollImagePublicUrl } from '../polls/images';
import type { Poll, PollSection, PollStatus, PollView } from '../polls/types';
import type { PollSavePayload } from '../polls/validate';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every polls column the client grants allow (created_by is not readable). */
const POLL_COLUMNS =
  'id,title,description,closes_at,is_schedule_vote,status,posted_at,first_posted_at,created_at,updated_at';
const POLL_SELECT = `${POLL_COLUMNS},poll_sections(id,name,answer_type,position,poll_options(id,name,image_path,position))`;

export interface PollListRow {
  id: string;
  title: string;
  status: PollStatus;
  posted_at: string | null;
  closes_at: string | null;
  created_at: string;
}

/** A refused or failed poll write, with the database's code and the message to show. */
export class PollError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PollError';
    this.code = code;
  }
}

export const POLL_ERROR_MESSAGES: Record<string, string> = {
  not_allowed: 'Only a full admin can change polls.',
  not_found: 'That poll no longer exists.',
  stale: 'Someone else saved this poll since you opened it. Reload to see their changes.',
  closing_passed: "This poll's closing date has passed. Change it before posting.",
  posted_cannot_delete: 'Unpost the poll before deleting it.',
  locked_by_votes: 'This poll has votes, so its questions and options can no longer change.',
};

export const POLL_UNKNOWN_ERROR = 'Something went wrong saving the poll.';

/** "Section 2, option 3: " for a field such as section.2.option.3.name, or '' for a poll-level field. */
function fieldPrefix(field: string): string {
  const match = /^section\.(\d+)(?:\.option\.(\d+))?/.exec(field);
  if (!match) return '';
  return match[2] ? `Section ${match[1]}, option ${match[2]}: ` : `Section ${match[1]}: `;
}

function invalidMessage(field: string, reason: string): string {
  const prefix = fieldPrefix(field);
  if (field === 'title') return 'The title must be 1 to 120 characters.';
  if (field === 'description') return 'The description can be at most 2,000 characters.';
  if (field === 'closes_at') {
    return reason === 'past' ? 'The closing date must be in the future.' : 'The closing date is not valid.';
  }
  if (field === 'sections') return 'A poll needs 1 to 20 sections.';
  if (field.endsWith('.options')) return `${prefix}this answer type needs a different number of options.`;
  if (reason === 'duplicate' && field.endsWith('.name'))
    return `${prefix}this name is already an option in this section.`;
  if (field.endsWith('.name')) return `${prefix}the name must be 1 to 120 characters.`;
  if (field.endsWith('.answer_type')) return `${prefix}choose an answer type.`;
  if (field.endsWith('.image')) return `${prefix}the image is not valid.`;
  if (field.endsWith('.id')) return `${prefix}this item does not belong to this poll. Reload the editor.`;
  return 'The poll could not be saved because something in it is not valid.';
}

/** The text for a database error message such as `stale` or `invalid:section.2.name:length`. */
export function pollErrorMessage(code: string): string {
  if (POLL_ERROR_MESSAGES[code]) return POLL_ERROR_MESSAGES[code];
  const invalid = /^invalid:([^:]+):([^:]+)$/.exec(code);
  if (invalid) return invalidMessage(invalid[1], invalid[2]);
  return POLL_UNKNOWN_ERROR;
}

/** Calls one poll function as the admin; a refusal becomes a PollError with its mapped message. */
async function callPollRpc<T>(
  env: SupabaseEnv,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${env.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = '';
    try {
      code = String((JSON.parse(text) as { message?: unknown }).message ?? '');
    } catch {
      code = '';
    }
    const message = pollErrorMessage(code);
    if (message === POLL_UNKNOWN_ERROR) console.error(`Poll function ${name} failed (${res.status}):`, text);
    throw new PollError(code || `http_${res.status}`, message);
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : null) as T;
}

/** A new draft with this title (BR2.1), only to get an id before images are uploaded. */
export async function createPoll(env: SupabaseEnv, accessToken: string, title: string): Promise<string> {
  return callPollRpc<string>(env, accessToken, 'create_poll', { p_title: title });
}

/**
 * Saves the whole poll and returns the image paths it no longer uses (BR4.2). `expectedUpdatedAt` is the
 * updated_at the editor loaded, passed through as text so its microseconds survive (BR5.5).
 */
export async function savePoll(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string,
  expectedUpdatedAt: string,
  payload: PollSavePayload,
): Promise<string[]> {
  const unused = await callPollRpc<string[] | null>(env, accessToken, 'save_poll', {
    p_poll_id: pollId,
    p_expected_updated_at: expectedUpdatedAt,
    p_poll: payload,
  });
  return Array.isArray(unused) ? unused : [];
}

/** Post (true) or Unpost (false), BR2.2 and BR2.3. */
export async function setPollPosted(env: SupabaseEnv, accessToken: string, pollId: string, posted: boolean) {
  await callPollRpc<null>(env, accessToken, 'set_poll_posted', { p_poll_id: pollId, p_posted: posted });
}

/** Deletes a draft with its sections and options (BR2.5); the caller clears its image folder. */
export async function deletePoll(env: SupabaseEnv, accessToken: string, pollId: string) {
  await callPollRpc<null>(env, accessToken, 'delete_poll', { p_poll_id: pollId });
}

/** Every poll, newest first, for the admin list (BR3.1). Drafts are readable only with a full admin's token. */
export function listPollsForAdmin(env: SupabaseEnv, accessToken: string): Promise<PollListRow[]> {
  return restGetAuthed<PollListRow[]>(
    env,
    accessToken,
    'polls?select=id,title,status,posted_at,closes_at,created_at&order=created_at.desc',
  );
}

/** The number of draft polls, for the Admin Tools card. */
export async function countDraftPolls(env: SupabaseEnv, accessToken: string): Promise<number> {
  const rows = await restGetAuthed<{ id: string }[]>(env, accessToken, 'polls?select=id&status=eq.draft');
  return rows.length;
}

type PollRow = Omit<Poll, 'sections'> & {
  poll_sections: (Omit<PollSection, 'options'> & { poll_options: PollSection['options'] })[] | null;
};

function toPoll(row: PollRow): Poll {
  const { poll_sections, ...poll } = row;
  const sections = [...(poll_sections ?? [])]
    .sort((a, b) => a.position - b.position)
    .map(({ poll_options, ...section }) => ({
      ...section,
      options: [...(poll_options ?? [])].sort((a, b) => a.position - b.position),
    }));
  return { ...poll, sections };
}

/** One poll with its sections and options, for the editor (admin token, so drafts are included). */
export async function getPollForEdit(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string,
): Promise<Poll | null> {
  if (!UUID_PATTERN.test(pollId)) return null;
  const rows = await restGetAuthed<PollRow[]>(
    env,
    accessToken,
    `polls?id=eq.${pollId}&select=${POLL_SELECT}`,
  );
  return rows[0] ? toPoll(rows[0]) : null;
}

/** The poll's stored updated_at, read right after create_poll so the first save is not stale. */
export async function getPollUpdatedAt(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string,
): Promise<string | null> {
  const rows = await restGetAuthed<{ updated_at: string }[]>(
    env,
    accessToken,
    `polls?id=eq.${pollId}&select=updated_at`,
  );
  return rows[0]?.updated_at ?? null;
}

/**
 * A posted poll for the public page, or null. The status filter is explicit: RLS alone would hand a draft to
 * a signed-in full admin, and the public page must 404 for drafts for everyone (BR3.3).
 */
export async function getPostedPoll(env: SupabaseEnv, pollId: string): Promise<Poll | null> {
  if (!UUID_PATTERN.test(pollId)) return null;
  const rows = await restGet<PollRow[]>(env, `polls?id=eq.${pollId}&status=eq.posted&select=${POLL_SELECT}`);
  return rows[0] ? toPoll(rows[0]) : null;
}

/** The public URL of an option image, resized for display (NFR2); null when the option has none. */
export function pollImageUrl(supabaseUrl: string, path: string | null, width: number): string | null {
  if (!path) return null;
  return resizedImageUrl(pollImagePublicUrl(supabaseUrl, path), { width });
}

/** The renderer's shape for a stored poll, with images at `imageWidth` pixels. */
export function pollToView(poll: Poll, supabaseUrl: string, imageWidth = 320): PollView {
  return {
    title: poll.title,
    description: poll.description,
    sections: poll.sections.map((s) => ({
      name: s.name,
      answerType: s.answer_type,
      options: s.options.map((o) => ({
        name: o.name,
        imageUrl: pollImageUrl(supabaseUrl, o.image_path, imageWidth),
      })),
    })),
  };
}
