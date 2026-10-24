/**
 * The Resend batch call (U7: BR10.9, BR10.12, NFR4.1, NFR4.2, NFR5.1): the request it sends, every response
 * class, the 10-second timeout, and that nothing it returns or logs carries the key or an address.
 * Resend is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESEND_BATCH_URL,
  classifyFailure,
  idempotencyKey,
  sendBatch,
  type SendBatchInput,
} from '../../src/lib/notifications/sender';

const KEY = 're_test_not_a_real_key';
const BATCH = '11111111-2222-4333-8444-555555555555';

const input = (overrides: Partial<SendBatchInput> = {}): SendBatchInput => ({
  apiKey: KEY,
  from: 'ATC <noreply@example.test>',
  batchId: BATCH,
  emails: [
    { to: 'a@example.test', subject: 'S1', html: '<p>1</p>', text: '1' },
    { to: 'b@example.test', subject: 'S2', html: '<p>2</p>', text: '2' },
  ],
  ...overrides,
});

const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

function stubFetch(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    typeof response === 'function' ? response() : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendBatch', () => {
  it('posts one batch with the key, the idempotency key and every email, and returns the ids in order', async () => {
    const fetchMock = stubFetch(respond({ data: [{ id: 'r-1' }, { id: 'r-2' }] }, 200));
    const outcome = await sendBatch(input());

    expect(outcome).toEqual({ kind: 'sent', status: 200, providerIds: ['r-1', 'r-2'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RESEND_BATCH_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `outbox-batch:${BATCH}`,
    });
    expect(JSON.parse(String(init?.body))).toEqual([
      {
        from: 'ATC <noreply@example.test>',
        to: ['a@example.test'],
        subject: 'S1',
        html: '<p>1</p>',
        text: '1',
      },
      {
        from: 'ATC <noreply@example.test>',
        to: ['b@example.test'],
        subject: 'S2',
        html: '<p>2</p>',
        text: '2',
      },
    ]);
  });

  it('still counts a 200 with an unreadable body as sent', async () => {
    stubFetch(new Response('not json', { status: 200 }));
    expect(await sendBatch(input())).toEqual({ kind: 'sent', status: 200, providerIds: [null, null] });
  });

  it.each([
    [409, 'invalid_idempotent_request', 'conflict'],
    [409, 'concurrent_idempotent_requests', 'in_progress'],
    [429, 'rate_limit_exceeded', 'rate_limited'],
    [429, 'daily_quota_exceeded', 'quota'],
    [500, 'internal_server_error', 'transient'],
    [503, null, 'transient'],
    [400, 'invalid_from_address', 'permanent'],
    [422, 'validation_error', 'permanent'],
    [401, 'missing_api_key', 'auth'],
    [403, 'invalid_api_key', 'auth'],
  ])('classifies %i %s as %s', async (status, name, kind) => {
    stubFetch(respond(name ? { statusCode: status, message: 'm', name } : {}, status));
    expect(await sendBatch(input())).toEqual({ kind, status, code: name });
  });

  it('gives up after the timeout and reports a transient timeout (NFR4.2)', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendBatch(input({ timeoutMs: 5 }))).toEqual({
      kind: 'transient',
      status: null,
      code: 'timeout',
    });
  });

  it('reports a network error as transient', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await sendBatch(input())).toEqual({ kind: 'transient', status: null, code: 'network_error' });
  });

  it('never logs, and returns no key, address or body (NFR5.1)', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    for (const response of [
      respond({ data: [{ id: 'r-1' }] }, 200),
      respond({ name: 'validation_error' }, 422),
    ]) {
      stubFetch(response);
      const outcome = JSON.stringify(await sendBatch(input()));
      expect(outcome).not.toContain(KEY);
      expect(outcome).not.toContain('@example.test');
      expect(outcome).not.toContain('<p>');
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('classifyFailure and idempotencyKey', () => {
  it('treats an unknown 409 as in progress and an unknown 4xx as permanent', () => {
    expect(classifyFailure(409, null)).toBe('in_progress');
    expect(classifyFailure(404, null)).toBe('permanent');
    expect(classifyFailure(429, null)).toBe('rate_limited');
  });

  it('keys the batch by its id', () => {
    expect(idempotencyKey(BATCH)).toBe(`outbox-batch:${BATCH}`);
  });
});
