/**
 * The editor's save and the list's delete as workflows (W1, W2, W4): upload new images, save the poll in one
 * database call, then clean up files. Cleanup is best effort and only logged (BR4.2, BR2.5).
 */
import type { SupabaseEnv } from '../db/client';
import { deleteFromStorage, listStorageFolder, uploadToStorage } from '../db/assets';
import {
  POLL_ERROR_MESSAGES,
  PollError,
  createPoll,
  deletePoll,
  getPollForEdit,
  getPollUpdatedAt,
  savePoll,
} from '../db/polls';
import { POLL_IMAGE_BUCKET, pollImagePath } from './images';
import { pollSavePayload, type PollForm } from './validate';

async function removeFiles(env: SupabaseEnv, accessToken: string, paths: string[], why: string): Promise<void> {
  if (paths.length === 0) return;
  const ok = await deleteFromStorage(env, accessToken, POLL_IMAGE_BUCKET, paths);
  if (!ok) console.error(`Poll image cleanup failed (${why}):`, paths.join(', '));
}

/** Uploads every chosen file under the poll's folder; returns option key -> stored path. */
async function uploadImages(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string,
  form: PollForm,
  uploaded: Map<string, string>,
): Promise<void> {
  const base = Date.now();
  let n = 0;
  for (const [i, section] of form.sections.entries()) {
    for (const [j, option] of section.options.entries()) {
      if (!option.file) continue;
      const path = pollImagePath(pollId, option.key, option.file.type, base + n++);
      if (!path) throw new PollError('upload', `Section ${i + 1}, option ${j + 1}: the image must be a PNG, JPEG or WebP file.`);
      try {
        await uploadToStorage(env, accessToken, POLL_IMAGE_BUCKET, path, option.file);
      } catch (err) {
        console.error('Poll image upload failed:', err);
        throw new PollError('upload', `Section ${i + 1}, option ${j + 1}: the image could not be uploaded. Try again.`);
      }
      uploaded.set(option.key, path);
    }
  }
}

/** True for a refusal the database raised itself, so the save surely rolled back (not a lost response). */
export function isPollRefusal(err: unknown): boolean {
  return err instanceof PollError && (Object.hasOwn(POLL_ERROR_MESSAGES, err.code) ||err.code.startsWith('invalid:'));
}

/** Removes the new draft after a failed first save; a failure here is only logged. */
async function removeDraft(env: SupabaseEnv, accessToken: string, pollId: string): Promise<void> {
  await deletePoll(env, accessToken, pollId).catch((err) =>
    console.error('Failed to remove the new draft after a failed save:', err),
  );
}

/**
 * After save_poll failed without a refusal, it may still have committed. Re-reads the poll and removes only
 * the uploaded files it does not reference (and the new draft only if it is still empty); if the poll cannot
 * be read, nothing is removed.
 */
async function cleanUpUncertainSave(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string,
  created: boolean,
  uploaded: string[],
): Promise<void> {
  let poll;
  try {
    poll = await getPollForEdit(env, accessToken, pollId);
  } catch (err) {
    console.error('Could not re-read the poll after a failed save, so its new images were kept:', err);
    return;
  }
  if (!poll) return;
  const referenced = new Set(poll.sections.flatMap((s) => s.options.map((o) => o.image_path)));
  await removeFiles(env, accessToken, uploaded.filter((path) => !referenced.has(path)), 'failed save');
  if (created && poll.sections.length === 0) await removeDraft(env, accessToken, pollId);
}

/**
 * Saves a form parsePollForm passed. A new poll (pollId null) is created first so its images have a folder.
 * When anything fails the error is rethrown after cleanup: files uploaded here (and that new draft) are removed,
 * unless save_poll may have committed, in which case only files the stored poll does not use are removed.
 */
export async function savePollFromForm(
  env: SupabaseEnv,
  accessToken: string,
  pollId: string | null,
  form: PollForm,
): Promise<{ pollId: string; created: boolean }> {
  const created = pollId === null;
  const id = pollId ?? (await createPoll(env, accessToken, form.title.trim()));
  const uploaded = new Map<string, string>();
  let saveSent = false;
  try {
    const expected = created ? await getPollUpdatedAt(env, accessToken, id) : form.expectedUpdatedAt;
    if (!expected) throw new PollError('stale', POLL_ERROR_MESSAGES.stale);
    await uploadImages(env, accessToken, id, form, uploaded);
    saveSent = true;
    const unused = await savePoll(env, accessToken, id, expected, pollSavePayload(form, uploaded));
    saveSent = false;
    await removeFiles(env, accessToken, unused, 'replaced or removed images');
    return { pollId: id, created };
  } catch (err) {
    if (saveSent && !isPollRefusal(err)) {
      await cleanUpUncertainSave(env, accessToken, id, created, [...uploaded.values()]);
    } else {
      await removeFiles(env, accessToken, [...uploaded.values()], 'failed save');
      if (created) await removeDraft(env, accessToken, id);
    }
    throw err;
  }
}

/** Deletes a draft, then every file in its image folder (best effort, BR2.5). */
export async function deletePollWithFiles(env: SupabaseEnv, accessToken: string, pollId: string): Promise<void> {
  await deletePoll(env, accessToken, pollId);
  try {
    const files = await listStorageFolder(env, accessToken, POLL_IMAGE_BUCKET, pollId);
    await removeFiles(env, accessToken, files, 'deleted poll');
  } catch (err) {
    console.error('Failed to list the deleted poll images:', err);
  }
}
