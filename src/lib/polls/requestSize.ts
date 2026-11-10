/**
 * The size limit on one poll save (polls BR4.1, NFR on the Worker's CPU budget). The server refuses a larger
 * body before parsing it, because parsing the multipart body is what costs CPU; the editor shrinks images and
 * checks the same limit before it submits, so a normal save never reaches the refusal.
 */
import type { PollFormError } from './validate';

/** The largest poll save body the editor pages will parse. */
export const POLL_SAVE_MAX_BYTES = 8 * 1024 * 1024;

/** Room the editor keeps for the text fields and multipart framing when it adds up the chosen images. */
export const POLL_SAVE_TEXT_ALLOWANCE = 256 * 1024;

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The refusal for a save whose Content-Length is missing, not a number or over the limit; null when the body
 * may be parsed. The body is never read, so only the stored poll (or a blank form) can be shown again.
 */
export function pollSaveSizeError(contentLength: string | null): PollFormError | null {
  const bytes =
    contentLength !== null && /^\d+$/.test(contentLength.trim()) ? Number(contentLength.trim()) : NaN;
  if (Number.isNaN(bytes)) {
    return { field: 'form', message: 'The save could not be read because its size was not sent. Try again.' };
  }
  if (bytes <= POLL_SAVE_MAX_BYTES) return null;
  return {
    field: 'form',
    message:
      `This save was ${formatMegabytes(bytes)}, over the ${formatMegabytes(POLL_SAVE_MAX_BYTES)} limit, so nothing in it ` +
      'was saved or kept. Choose smaller images, or fewer at a time, and make your changes again.',
  };
}

/** The editor's message when the chosen images add up to more than one save can carry; null when they fit. */
export function pollImagesBudgetMessage(imageBytes: number): string | null {
  const budget = POLL_SAVE_MAX_BYTES - POLL_SAVE_TEXT_ALLOWANCE;
  if (imageBytes <= budget) return null;
  return (
    `The new images add up to ${formatMegabytes(imageBytes)}, and one save can carry about ${formatMegabytes(budget)}. ` +
    'Remove some images, save, then add the rest in a second save.'
  );
}
