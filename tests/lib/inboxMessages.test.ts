/**
 * The in-site notifications' text and links (src/lib/inbox/messages.ts; notifications BR3.1, BR3.2, BR1.2):
 * each kind's message and link, the round part left out while a round has no number, the "a recent round"
 * fallback, the bell's badge text and accessible name, and relative times.
 */
import { describe, expect, it } from 'vitest';
import {
  bellLabel,
  notificationHref,
  notificationMessage,
  relativeTime,
  roundLabel,
  toNotificationItem,
  unreadBadgeText,
  type NotificationRow,
} from '../../src/lib/inbox/messages';

const PENALTY = 'cccccccc-0000-4000-8000-000000000911';
const POLL = 'dddddddd-0000-4000-8000-000000000001';

function row(kind: number, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: `id-${kind}`,
    kind,
    created_at: '2026-11-09T12:00:00+00:00',
    was_unread: true,
    subsession_id: kind === 6 ? null : 81234567,
    season_label: kind === 6 ? null : 'ATC18',
    round_number: kind === 6 ? null : 7,
    track_name: kind === 6 ? null : 'Portland',
    penalty_id: kind === 5 ? PENALTY : null,
    poll_id: kind === 6 ? POLL : null,
    ...overrides,
  };
}

describe('notificationMessage and notificationHref (BR3.1, BR3.2)', () => {
  it.each([
    [1, 'Race Results Posted for ATC18, Round 7 at Portland', '/results/81234567'],
    [2, 'Incident Report Posted for ATC18, Round 7 at Portland', '/results/81234567/incidents'],
    [3, 'Incident Appeals now open for ATC18, Round 7 at Portland', '/results/81234567/incidents?open=appeal'],
    [4, 'Incident Submissions now open for ATC18, Round 7 at Portland', '/results/81234567?submit=incident'],
    [
      5,
      'Your Incident Appeal for ATC18, Round 7 at Portland has been closed',
      `/results/81234567/incidents?open=incident&penalty=${PENALTY}`,
    ],
    [6, "Voting for next season's schedule is now open", `/polls/${POLL}`],
  ])('kind %i', (kind, message, href) => {
    expect(notificationMessage(row(kind))).toBe(message);
    expect(notificationHref(row(kind))).toBe(href);
  });

  it('leaves the round part out until the round has a number (Q2 A)', () => {
    expect(notificationMessage(row(1, { round_number: null }))).toBe('Race Results Posted for ATC18 at Portland');
    expect(roundLabel({ season_label: ' ATC18 ', round_number: null, track_name: 'Portland' })).toBe(
      'ATC18 at Portland',
    );
  });

  it('falls back to "a recent round" when the season or track is missing', () => {
    expect(notificationMessage(row(2, { season_label: null }))).toBe('Incident Report Posted for a recent round');
    expect(notificationMessage(row(5, { track_name: '  ' }))).toBe(
      'Your Incident Appeal for a recent round has been closed',
    );
  });

  it('never names a driver: the text uses only season, round and track (BR5.2)', () => {
    const text = notificationMessage(row(1, { season_label: 'ATC18', track_name: 'Portland' }));
    expect(text.replace('ATC18, Round 7 at Portland', '')).toBe('Race Results Posted for ');
  });

  it('degrades safely when a reference is missing', () => {
    expect(notificationHref(row(5, { penalty_id: null }))).toBe('/results/81234567/incidents');
    expect(notificationHref(row(6, { poll_id: null }))).toBe('/');
    expect(notificationHref(row(1, { subsession_id: null }))).toBe('/results');
    expect(notificationMessage(row(9))).toBe('New notification');
  });

  it('builds the popup item from a row', () => {
    expect(toNotificationItem(row(3, { was_unread: false }))).toEqual({
      id: 'id-3',
      kind: 3,
      createdAt: '2026-11-09T12:00:00+00:00',
      unread: false,
      message: 'Incident Appeals now open for ATC18, Round 7 at Portland',
      href: '/results/81234567/incidents?open=appeal',
    });
  });
});

describe('the bell badge (BR1.2)', () => {
  it('shows nothing at 0, the count up to 9, then 9+', () => {
    expect(unreadBadgeText(0)).toBe('');
    expect(unreadBadgeText(-3)).toBe('');
    expect(unreadBadgeText(Number.NaN)).toBe('');
    expect(unreadBadgeText(1)).toBe('1');
    expect(unreadBadgeText(9)).toBe('9');
    expect(unreadBadgeText(10)).toBe('9+');
    expect(unreadBadgeText(250)).toBe('9+');
  });

  it('puts the count in the accessible name (NFR6)', () => {
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(12)).toBe('Notifications (12 unread)');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  it.each([
    ['2026-11-09T11:59:30Z', 'just now'],
    ['2026-11-09T12:05:00Z', 'just now'],
    ['2026-11-09T11:59:00Z', '1 minute ago'],
    ['2026-11-09T11:15:00Z', '45 minutes ago'],
    ['2026-11-09T10:00:00Z', '2 hours ago'],
    ['2026-11-08T12:00:00Z', '1 day ago'],
    ['2026-10-01T12:00:00Z', '1 month ago'],
    ['2024-11-01T12:00:00Z', '2 years ago'],
    ['not a date', ''],
  ])('%s reads "%s"', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});
