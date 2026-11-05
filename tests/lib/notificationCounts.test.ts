/**
 * The email counts parser's new "sent in the last 7 days" figure (FR5.7; BR5.13, D6): read when present,
 * null when missing or invalid, and never a reason to drop the other four figures.
 */
import { describe, expect, it } from 'vitest';
import { parseNotificationCounts } from '../../src/lib/notifications/counts';

const OLD_SHAPE = {
  queued: 3,
  dropped_7d: 2,
  cap_dropped_7d: 1,
  unknown_7d: 0,
  enqueue_failures_7d: 1,
  last_run_status: 'ok',
  last_run_at: '2026-11-04T12:00:00+00:00',
};

describe('email counts: sent_7d (BR5.13)', () => {
  it('reads sent_7d when the function returns it', () => {
    expect(parseNotificationCounts({ ...OLD_SHAPE, sent_7d: 12 })?.sent7d).toBe(12);
  });

  it('accepts a numeric string, as jsonb counts can arrive', () => {
    expect(parseNotificationCounts({ ...OLD_SHAPE, sent_7d: '4' })?.sent7d).toBe(4);
  });

  it('gives null for a missing key and keeps the other figures', () => {
    const counts = parseNotificationCounts(OLD_SHAPE);
    expect(counts?.sent7d).toBeNull();
    expect(counts?.queued).toBe(3);
    expect(counts?.enqueueFailures7d).toBe(1);
  });

  it('gives null for an invalid value without invalidating the result', () => {
    for (const bad of [-1, 1.5, 'many', null, {}]) {
      const counts = parseNotificationCounts({ ...OLD_SHAPE, sent_7d: bad });
      expect(counts, String(bad)).not.toBeNull();
      expect(counts?.sent7d, String(bad)).toBeNull();
    }
  });

  it('still refuses a result whose required figures are wrong, whatever sent_7d says', () => {
    expect(parseNotificationCounts({ ...OLD_SHAPE, queued: -1, sent_7d: 5 })).toBeNull();
    expect(parseNotificationCounts({ sent_7d: 5 })).toBeNull();
  });
});
