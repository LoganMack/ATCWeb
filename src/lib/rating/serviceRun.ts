/**
 * The scheduled Series iRating run (BR2.6): the Worker's 15-minute cron calls public.rating_process_pending()
 * with the service role, which recomputes whatever is still queued (large rescores, and at-commit runs that
 * were skipped or failed). The database does all the rating maths; this only calls it and logs the outcome.
 * It never throws, so a rating failure can never stop the notifications run beside it.
 */
import { createServiceDb, type NotificationEnv, type ServiceDb } from '../notifications/db';

/** What rating_process_pending() returns, plus 'failed' when the call itself did not complete. */
export interface RatingRunResult {
  status: 'ok' | 'idle' | 'paused' | 'error' | 'failed';
  queued?: number;
  races?: number;
  ms?: number;
  error?: string;
}

export async function runPendingRatings(
  env: NotificationEnv,
  db: Pick<ServiceDb, 'rpc'> = createServiceDb(env),
): Promise<RatingRunResult> {
  try {
    const result = (await db.rpc<RatingRunResult | null>('rating_process_pending')) ?? { status: 'idle' };
    if (result.status === 'error') {
      console.error(`series ratings: the scheduled recompute failed and stays queued: ${result.error ?? 'unknown error'}`);
    } else if (result.status === 'ok') {
      console.log(`series ratings: rated ${result.races ?? 0} races in ${result.ms ?? 0} ms`);
    } else if (result.status === 'paused') {
      console.warn(`series ratings: paused by the scoring kill switch, ${result.queued ?? 0} entries queued`);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`series ratings: the scheduled run could not reach the database: ${message}`);
    return { status: 'failed', error: message };
  }
}
