/** A poll's displayed status (src/lib/polls/status.ts; polls BR3.3, BR3.4). */
import { describe, expect, it } from 'vitest';
import { POLL_STATUS_LABELS, pollDisplayStatus, pollPublicNote } from '../../src/lib/polls/status';

const NOW = new Date('2026-11-15T12:00:00Z');

describe('pollDisplayStatus', () => {
  it('is Draft for a draft, even one whose closing date has passed', () => {
    expect(pollDisplayStatus({ status: 'draft', closes_at: null }, NOW)).toBe('draft');
    expect(pollDisplayStatus({ status: 'draft', closes_at: '2026-11-01T00:00:00Z' }, NOW)).toBe('draft');
  });

  it('is Posted for a posted poll with no closing date', () => {
    expect(pollDisplayStatus({ status: 'posted', closes_at: null }, NOW)).toBe('posted');
  });

  it('is Posted until the closing time and Closed from it', () => {
    expect(pollDisplayStatus({ status: 'posted', closes_at: '2026-11-15T12:00:01Z' }, NOW)).toBe('posted');
    expect(pollDisplayStatus({ status: 'posted', closes_at: '2026-11-15T12:00:00Z' }, NOW)).toBe('closed');
    expect(pollDisplayStatus({ status: 'posted', closes_at: '2026-11-15T07:00:00-05:00' }, NOW)).toBe('closed');
  });

  it('treats an unreadable closing date as no closing date', () => {
    expect(pollDisplayStatus({ status: 'posted', closes_at: 'nonsense' }, NOW)).toBe('posted');
  });

  it('labels each status and gives the public page its note', () => {
    expect(POLL_STATUS_LABELS).toEqual({ draft: 'Draft', posted: 'Posted', closed: 'Closed' });
    expect(pollPublicNote('posted')).toBe('Voting opens soon');
    expect(pollPublicNote('closed')).toBe('This poll has closed');
  });
});
