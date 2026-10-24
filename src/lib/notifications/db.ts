/**
 * Service-role RPC client for the scheduled notifications run. SUPABASE_SERVICE_ROLE_KEY is read only here
 * and in src/lib/signups.ts (the bot API); page requests never use this client.
 */

/** The Worker env the run reads: wrangler.jsonc vars plus the two Cloudflare secrets. */
export interface NotificationEnv {
  PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_DAILY_CAP?: string;
  EMAIL_BATCH_SIZE?: string;
  SITE_URL?: string;
}

/** The database functions the run may call; each is executable by service_role only. */
export type NotificationRpc =
  | 'notifications_enqueue_reminders'
  | 'notifications_drop_expired'
  | 'notifications_take_stale_batch'
  | 'notifications_claim_batch'
  | 'notifications_store_rendered'
  | 'notifications_mark_batch'
  | 'notifications_record_run';

export interface ServiceDb {
  rpc<T>(fn: NotificationRpc, args?: Record<string, unknown>): Promise<T>;
}

/** PostgREST error bodies are JSON with a `message`; kept short so a log line stays one line. */
async function readDbError(res: Response): Promise<string> {
  const text = await res.text();
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // Not JSON: keep the raw text.
  }
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

/** Missing configuration fails each call rather than the run, so every step still logs its own failure. */
export function createServiceDb(env: NotificationEnv): ServiceDb {
  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    async rpc<T>(fn: NotificationRpc, args: Record<string, unknown> = {}): Promise<T> {
      if (!url || !key) throw new Error('PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured');
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`Supabase rpc error ${res.status} on ${fn}: ${await readDbError(res)}`);
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}
