/**
 * In-site notifications data access (notifications U3; BR1.2, BR2.1). Both calls run as the signed-in
 * account, whose token the database functions act on, so a caller only ever reaches their own rows.
 * Errors are thrown to the caller.
 */
import { restRpc, withAccessToken, type SupabaseEnv } from './client';
import type { NotificationRow } from '../inbox/messages';

export interface OpenNotificationsResult {
  items: NotificationRow[];
  unreadLeft: number;
}

/** The caller's unread count (notification_unread_count). */
export async function getUnreadCount(env: SupabaseEnv, accessToken: string): Promise<number> {
  const count = await restRpc<unknown>(withAccessToken(env, accessToken), 'notification_unread_count', {});
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error(`notification_unread_count returned ${JSON.stringify(count)}`);
  }
  return count;
}

/** Lists the 50 newest and marks those read in one database call (open_my_notifications). */
export async function openNotifications(env: SupabaseEnv, accessToken: string): Promise<OpenNotificationsResult> {
  const raw = await restRpc<{ items?: unknown; unread_left?: unknown } | null>(
    withAccessToken(env, accessToken),
    'open_my_notifications',
    {},
  );
  if (!raw || !Array.isArray(raw.items) || typeof raw.unread_left !== 'number') {
    throw new Error('open_my_notifications returned an unexpected shape');
  }
  return { items: raw.items as NotificationRow[], unreadLeft: Math.max(0, raw.unread_left) };
}
