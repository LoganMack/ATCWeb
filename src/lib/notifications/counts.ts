/**
 * The admin home's email counts (BR10.17, NFR9.3), read with the admin's own token through
 * notifications_admin_counts(), which checks is_admin() itself. Never throws: on any error it logs and
 * returns null, and the page shows "Email counts unavailable" instead of failing.
 */
import type { SupabaseEnv } from '../db/client';

export interface NotificationCounts {
  queued: number;
  dropped7d: number;
  capDropped7d: number;
  unknown7d: number;
  enqueueFailures7d: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  /** The latest run found no RESEND_API_KEY, so nothing is being sent. */
  sendingOff: boolean;
}

function count(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** The function's jsonb result, or null when it isn't the expected shape. */
export function parseNotificationCounts(raw: unknown): NotificationCounts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const values = [r.queued, r.dropped_7d, r.cap_dropped_7d, r.unknown_7d, r.enqueue_failures_7d].map(count);
  if (values.some((v) => v === null)) return null;
  const [queued, dropped7d, capDropped7d, unknown7d, enqueueFailures7d] = values as number[];
  const lastRunStatus = typeof r.last_run_status === 'string' ? r.last_run_status : null;
  return {
    queued,
    dropped7d,
    capDropped7d,
    unknown7d,
    enqueueFailures7d,
    lastRunStatus,
    lastRunAt: typeof r.last_run_at === 'string' ? r.last_run_at : null,
    sendingOff: lastRunStatus === 'no_key',
  };
}

export async function getNotificationCounts(
  env: SupabaseEnv,
  accessToken: string,
): Promise<NotificationCounts | null> {
  try {
    const res = await fetch(`${env.url}/rest/v1/rpc/notifications_admin_counts`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) throw new Error(`Supabase rpc error ${res.status} on notifications_admin_counts`);
    const counts = parseNotificationCounts(await res.json());
    if (!counts) throw new Error('notifications_admin_counts returned an unexpected shape');
    return counts;
  } catch (err) {
    console.error('Failed to load email counts:', err);
    return null;
  }
}
