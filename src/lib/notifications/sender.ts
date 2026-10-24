/**
 * One Resend batch call (contract C8): POST /emails/batch with `Idempotency-Key: outbox-batch:<batch id>`,
 * so the same batch sent again returns Resend's original result instead of sending twice. A 10-second
 * timeout; the response is classified by status and Resend's error `name`. Nothing here logs: the key, the
 * addresses and the body stay out of every message this module returns.
 */

export const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch';
export const SEND_TIMEOUT_MS = 10_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * What the run does with each outcome is in run.ts. `in_progress` and `conflict` are the two 409s;
 * `rate_limited` and `quota` the two 429s; `auth` a refused key; `transient` a 5xx, timeout or network
 * error; `permanent` a 400, 422 or other 4xx.
 */
export type FailureKind =
  'in_progress' | 'conflict' | 'rate_limited' | 'quota' | 'auth' | 'transient' | 'permanent';

export type SendOutcome =
  | { kind: 'sent'; status: number; providerIds: (string | null)[] }
  | { kind: FailureKind; status: number | null; code: string | null };

export interface SendBatchInput {
  apiKey: string;
  from: string;
  batchId: string;
  emails: OutgoingEmail[];
  timeoutMs?: number;
}

export function idempotencyKey(batchId: string): string {
  return `outbox-batch:${batchId}`;
}

export function classifyFailure(status: number, code: string | null): FailureKind {
  if (status === 409) return code === 'invalid_idempotent_request' ? 'conflict' : 'in_progress';
  if (status === 429)
    return code === 'daily_quota_exceeded' || code === 'monthly_quota_exceeded' ? 'quota' : 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/** Resend's error body is `{ statusCode, message, name }`; only the name is kept. */
async function errorName(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === 'string' ? body.name.slice(0, 64) : null;
  } catch {
    return null;
  }
}

async function providerIds(res: Response, count: number): Promise<(string | null)[]> {
  let data: unknown = null;
  try {
    data = ((await res.json()) as { data?: unknown }).data;
  } catch {
    // An unreadable 200 still means Resend accepted the batch.
  }
  const list = Array.isArray(data) ? data : [];
  return Array.from({ length: count }, (_, i) => {
    const id = (list[i] as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' ? id : null;
  });
}

export async function sendBatch(input: SendBatchInput): Promise<SendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_BATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey(input.batchId),
      },
      body: JSON.stringify(
        input.emails.map((e) => ({
          from: input.from,
          to: [e.to],
          subject: e.subject,
          html: e.html,
          text: e.text,
        })),
      ),
      signal: controller.signal,
    });
    if (res.ok)
      return { kind: 'sent', status: res.status, providerIds: await providerIds(res, input.emails.length) };
    const code = await errorName(res);
    return { kind: classifyFailure(res.status, code), status: res.status, code };
  } catch (err) {
    const timedOut = controller.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError';
    return { kind: 'transient', status: null, code: timedOut ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
