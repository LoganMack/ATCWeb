import type { PollDisplayStatus, PollStatus } from './types';

export const POLL_STATUS_LABELS: Record<PollDisplayStatus, string> = {
  draft: 'Draft',
  posted: 'Posted',
  closed: 'Closed',
};

/** Draft, Posted, or Closed for a posted poll whose closing time has been reached (BR3.4). */
export function pollDisplayStatus(
  poll: { status: PollStatus; closes_at: string | null },
  now: Date,
): PollDisplayStatus {
  if (poll.status !== 'posted') return 'draft';
  if (poll.closes_at === null) return 'posted';
  const closes = new Date(poll.closes_at).getTime();
  return Number.isFinite(closes) && closes <= now.getTime() ? 'closed' : 'posted';
}

/** The public page's note under the title (BR3.3); voting itself comes in a later change. */
export function pollPublicNote(status: PollDisplayStatus): string {
  return status === 'closed' ? 'This poll has closed' : 'Voting opens soon';
}
