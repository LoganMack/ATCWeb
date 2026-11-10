/**
 * The in-site notifications' text and links (notifications U3; BR3.1, BR3.2, BR1.2). Rows store references
 * only, so the text is built here when the popup opens, from labels the database reads at that moment.
 * Pure functions; the email Worker's own copy lives in src/lib/notifications.
 */

/** One row of open_my_notifications() (entities.md NotificationListItem). */
export interface NotificationRow {
  id: string;
  kind: number;
  created_at: string;
  was_unread: boolean;
  subsession_id: number | null;
  season_label: string | null;
  round_number: number | null;
  track_name: string | null;
  penalty_id: string | null;
  poll_id: string | null;
}

/** What the popup renders for one notification. */
export interface NotificationItem {
  id: string;
  kind: number;
  createdAt: string;
  unread: boolean;
  message: string;
  href: string;
}

const FALLBACK_ROUND = 'a recent round';

/** "ATC18, Round 7 at Portland"; the round part is left out until the round has a number (Q2 A). */
export function roundLabel(
  row: Pick<NotificationRow, 'season_label' | 'round_number' | 'track_name'>,
): string {
  const season = row.season_label?.trim();
  const track = row.track_name?.trim();
  if (!season || !track) return FALLBACK_ROUND;
  const round = row.round_number != null ? `, Round ${row.round_number}` : '';
  return `${season}${round} at ${track}`;
}

/** The message for one notification (BR3.1). Never names a driver (BR5.2). */
export function notificationMessage(row: NotificationRow): string {
  const label = roundLabel(row);
  switch (row.kind) {
    case 1:
      return `Race Results Posted for ${label}`;
    case 2:
      return `Incident Report Posted for ${label}`;
    case 3:
      return `Incident Appeals now open for ${label}`;
    case 4:
      return `Incident Submissions now open for ${label}`;
    case 5:
      return `Your Incident Appeal for ${label} has been closed`;
    case 6:
      return "Voting for next season's schedule is now open";
    default:
      return 'New notification';
  }
}

/** Where a notification leads (BR3.2); the incident page's popups open from client-read parameters. */
export function notificationHref(row: NotificationRow): string {
  if (row.kind === 6) return row.poll_id ? `/polls/${encodeURIComponent(row.poll_id)}` : '/';
  if (row.subsession_id == null) return '/results';
  const round = `/results/${row.subsession_id}`;
  switch (row.kind) {
    case 1:
      return round;
    case 2:
      return `${round}/incidents`;
    case 3:
      return `${round}/incidents?open=appeal`;
    case 4:
      return `${round}?submit=incident`;
    case 5:
      return row.penalty_id
        ? `${round}/incidents?open=incident&penalty=${encodeURIComponent(row.penalty_id)}`
        : `${round}/incidents`;
    default:
      return round;
  }
}

export function toNotificationItem(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    unread: row.was_unread,
    message: notificationMessage(row),
    href: notificationHref(row),
  };
}

/** The bell dot's text: nothing at 0, the count up to 9, then 9+ (BR1.2). */
export function unreadBadgeText(count: number): string {
  if (!Number.isFinite(count) || count < 1) return '';
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** The bell's accessible name, with the count when there is one (BR1.2, NFR6). */
export function bellLabel(count: number): string {
  return Number.isFinite(count) && count > 0
    ? `Notifications (${Math.floor(count)} unread)`
    : 'Notifications';
}

const UNITS: [limitMs: number, unitMs: number, name: string][] = [
  [60 * 60 * 1000, 60 * 1000, 'minute'],
  [24 * 60 * 60 * 1000, 60 * 60 * 1000, 'hour'],
  [30 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 'day'],
  [365 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000, 'month'],
  [Infinity, 365 * 24 * 60 * 60 * 1000, 'year'],
];

/** "just now", "5 minutes ago", "2 days ago". A time in the future (clock skew) reads "just now". */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const elapsed = now.getTime() - then;
  if (elapsed < 60 * 1000) return 'just now';
  const [, unitMs, name] = UNITS.find(([limit]) => elapsed < limit)!;
  const n = Math.floor(elapsed / unitMs);
  return `${n} ${name}${n === 1 ? '' : 's'} ago`;
}
