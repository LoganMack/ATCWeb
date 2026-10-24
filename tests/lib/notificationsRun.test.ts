/**
 * One scheduled notifications run (U7: BR10.8-BR10.13, BR10.19, BR10.20; NFR3.1, NFR3.2, NFR4.4-NFR4.7,
 * NFR5.1, NFR9.1, NFR9.2): the step order and isolation, no key, stale re-sends, each Resend outcome's mark,
 * the call budget through real fetch, a timing guard, the config, and the admin counts reader. The database
 * and Resend are fakes, or stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRpc, ServiceDb } from '../../src/lib/notifications/db';
import { RESEND_BATCH_URL, type SendBatchInput, type SendOutcome } from '../../src/lib/notifications/sender';
import { renderEmail } from '../../src/lib/notifications/templates';
import {
  DEFAULT_EMAIL_FROM,
  resolveNotificationConfig,
  runNotifications,
  type RunDeps,
  type RunSummary,
} from '../../src/lib/notifications/run';
import { getNotificationCounts, parseNotificationCounts } from '../../src/lib/notifications/counts';

const RESEND_KEY = 're_test_not_a_real_key';
const SERVICE_KEY = 'service-role-test-key';
const ENV = {
  PUBLIC_SUPABASE_URL: 'https://project.example.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  RESEND_API_KEY: RESEND_KEY,
  EMAIL_FROM: 'ATC <noreply@example.test>',
  EMAIL_DAILY_CAP: '100',
  EMAIL_BATCH_SIZE: '50',
  SITE_URL: 'https://site.example.test',
};
const NOW = new Date('2026-10-24T13:00:00Z');
const PAYLOAD = { subsession_id: 9907001, season_label: 'Zr Season', round_number: 3 };

type Handler = (args: Record<string, unknown>) => unknown;

const DEFAULTS: Record<NotificationRpc, Handler> = {
  notifications_enqueue_reminders: () => ({ enqueued: 0, missed_windows: [] }),
  notifications_drop_expired: () => ({ dropped: [], retention_deleted: 0 }),
  notifications_take_stale_batch: () => ({
    batch_id: null,
    rows: [],
    stale_unknown: [],
    released: 0,
    address_changed: 0,
  }),
  notifications_claim_batch: (args) => ({ batch_id: args.p_batch_id, rows: [], dropped: [], cap_left: 100 }),
  notifications_store_rendered: (args) => (args.p_rendered as unknown[]).length,
  notifications_mark_batch: () => ({ outcome: 'sent', updated: 1 }),
  notifications_record_run: () => 'run-row',
};

function claimRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${i + 1}`,
    kind: 'report_posted',
    profile_id: `profile-${i + 1}`,
    payload: PAYLOAD,
    to: `driver${i + 1}@example.test`,
  }));
}

const claiming =
  (count: number): Handler =>
  (args) => ({
    batch_id: args.p_batch_id,
    rows: claimRows(count),
    dropped: [],
    cap_left: 100 - count,
  });

function harness(handlers: Partial<Record<NotificationRpc, Handler>> = {}, outcomes: SendOutcome[] = []) {
  const calls: { fn: NotificationRpc; args: Record<string, unknown> }[] = [];
  const db: ServiceDb = {
    async rpc<T>(fn: NotificationRpc, args: Record<string, unknown> = {}) {
      calls.push({ fn, args });
      return (await (handlers[fn] ?? DEFAULTS[fn])(args)) as T;
    },
  };
  const logs: string[] = [];
  const errors: string[] = [];
  let ids = 0;
  const send = vi.fn(async (input: SendBatchInput): Promise<SendOutcome> => {
    return (
      outcomes.shift() ?? {
        kind: 'sent',
        status: 200,
        providerIds: input.emails.map((_, i) => `resend-${i + 1}`),
      }
    );
  });
  const deps: Partial<RunDeps> = {
    db,
    send,
    now: () => NOW,
    newId: () => (ids++ === 0 ? 'run-1' : `batch-${ids - 1}`),
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  };
  const fnCalls = () => calls.map((c) => c.fn.replace('notifications_', ''));
  const argsOf = (fn: NotificationRpc) => calls.filter((c) => c.fn === fn).map((c) => c.args);
  return { deps, calls, fnCalls, argsOf, send, logs, errors };
}

const lastSummary = (logs: string[]) => JSON.parse(logs[logs.length - 1]) as RunSummary;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runNotifications: the step sequence', () => {
  it('enqueues, drops, checks for a stale batch, claims, stores, sends, marks and records, in that order', async () => {
    const h = harness({ notifications_claim_batch: claiming(2) });
    const summary = await runNotifications(ENV, h.deps);

    expect(h.fnCalls()).toEqual([
      'enqueue_reminders',
      'drop_expired',
      'take_stale_batch',
      'claim_batch',
      'store_rendered',
      'mark_batch',
      'record_run',
    ]);
    expect(h.argsOf('notifications_claim_batch')[0]).toEqual({
      p_batch_id: 'batch-1',
      p_batch_size: 50,
      p_daily_cap: 100,
    });
    const stored = h.argsOf('notifications_store_rendered')[0].p_rendered as {
      id: string;
      rendered: { subject: string };
    }[];
    expect(stored.map((r) => [r.id, r.rendered.subject])).toEqual([
      ['row-1', 'Incident report posted: Zr Season Round 3'],
      ['row-2', 'Incident report posted: Zr Season Round 3'],
    ]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({
      apiKey: RESEND_KEY,
      from: ENV.EMAIL_FROM,
      batchId: 'batch-1',
    });
    expect(h.argsOf('notifications_mark_batch')[0]).toEqual({
      p_batch_id: 'batch-1',
      p_result: {
        outcome: 'sent',
        provider_ids: [
          { id: 'row-1', provider_id: 'resend-1' },
          { id: 'row-2', provider_id: 'resend-2' },
        ],
      },
    });
    expect(summary).toMatchObject({
      status: 'ok',
      claimed: 2,
      sent: 2,
      failed: 0,
      cap_left: 98,
      run_id: 'run-1',
    });
    expect((h.argsOf('notifications_record_run')[0].p_summary as RunSummary).status).toBe('ok');
    expect(lastSummary(h.logs)).toMatchObject({ event: 'notifications-run', sent: 2, batch_size: 50 });
  });

  it('without RESEND_API_KEY still enqueues and drops, sends nothing and logs one line (BR10.13)', async () => {
    const h = harness({ notifications_claim_batch: claiming(2) });
    const summary = await runNotifications({ ...ENV, RESEND_API_KEY: '' }, h.deps);

    expect(h.fnCalls()).toEqual(['enqueue_reminders', 'drop_expired', 'record_run']);
    expect(h.send).not.toHaveBeenCalled();
    expect(summary.status).toBe('no_key');
    expect(h.logs).toHaveLength(1);
    expect(lastSummary(h.logs).status).toBe('no_key');
  });

  it('logs a failing step, runs the others, records the run and then rejects (NFR4.6)', async () => {
    const h = harness({
      notifications_enqueue_reminders: () => {
        throw new Error('Supabase rpc error 500 on notifications_enqueue_reminders: boom');
      },
      notifications_claim_batch: claiming(1),
    });

    await expect(runNotifications(ENV, h.deps)).rejects.toThrow(/run-1 failed in: enqueue_reminders/);
    expect(h.fnCalls()).toEqual([
      'enqueue_reminders',
      'drop_expired',
      'take_stale_batch',
      'claim_batch',
      'store_rendered',
      'mark_batch',
      'record_run',
    ]);
    expect(JSON.parse(h.errors[0])).toMatchObject({
      event: 'notifications-step-failed',
      step: 'enqueue_reminders',
    });
    expect(h.argsOf('notifications_record_run')[0].p_summary).toMatchObject({
      status: 'partial',
      failed_steps: ['enqueue_reminders'],
      sent: 1,
    });
  });

  it('logs each drop with its ids and reason, and counts reasons in the summary (NFR9.2)', async () => {
    const h = harness({
      notifications_drop_expired: () => ({
        dropped: [{ id: 'o-1', kind: 'event_reminder', profile_id: 'p-1', reason: 'cap_expired' }],
        retention_deleted: 4,
      }),
      notifications_enqueue_reminders: () => ({ enqueued: 3, missed_windows: ['e-1'] }),
    });
    const summary = await runNotifications(ENV, h.deps);

    expect(JSON.parse(h.logs[0])).toEqual({
      event: 'notifications-dropped',
      run_id: 'run-1',
      outbox_id: 'o-1',
      kind: 'event_reminder',
      profile_id: 'p-1',
      reason: 'cap_expired',
    });
    expect(summary).toMatchObject({
      enqueued: 3,
      missed_windows: ['e-1'],
      dropped: { cap_expired: 1 },
      retention_deleted: 4,
    });
  });
});

describe('runNotifications: stale batches (NFR4.4)', () => {
  const staleRow = {
    id: 's-1',
    profile_id: 'p-1',
    rendered: { subject: 'Stored subject', html: '<p>stored</p>', text: 'stored' },
    to: 'a@example.test',
  };

  it('re-sends a stale batch unchanged under its own id, then still claims a new batch', async () => {
    const h = harness({
      notifications_take_stale_batch: () => ({
        batch_id: 'stale-1',
        rows: [staleRow],
        stale_unknown: [],
        released: 0,
        address_changed: 0,
      }),
      notifications_claim_batch: claiming(1),
    });
    const summary = await runNotifications(ENV, h.deps);

    expect(h.send.mock.calls.map((c) => c[0].batchId)).toEqual(['stale-1', 'batch-1']);
    expect(h.send.mock.calls[0][0].emails).toEqual([{ to: 'a@example.test', ...staleRow.rendered }]);
    expect(h.argsOf('notifications_store_rendered')).toHaveLength(1);
    expect(h.argsOf('notifications_mark_batch').map((a) => a.p_batch_id)).toEqual(['stale-1', 'batch-1']);
    expect(summary).toMatchObject({ resent_batch: 'stale-1', sent: 2 });
  });

  it('after "Resend accepted, mark failed", the next run sends the same batch id and the same bytes', async () => {
    const first = harness({
      notifications_claim_batch: claiming(1),
      notifications_mark_batch: () => {
        throw new Error('Supabase rpc error 503 on notifications_mark_batch: unavailable');
      },
    });
    await expect(runNotifications(ENV, first.deps)).rejects.toThrow(/claim_and_send/);
    const stored = first.argsOf('notifications_store_rendered')[0].p_rendered as {
      id: string;
      rendered: object;
    }[];

    const second = harness({
      notifications_take_stale_batch: () => ({
        batch_id: 'batch-1',
        rows: [
          {
            id: stored[0].id,
            profile_id: 'profile-1',
            rendered: stored[0].rendered,
            to: 'driver1@example.test',
          },
        ],
        stale_unknown: [],
        released: 0,
        address_changed: 0,
      }),
    });
    await runNotifications(ENV, second.deps);

    expect(second.send.mock.calls[0][0].batchId).toBe(first.send.mock.calls[0][0].batchId);
    expect(second.send.mock.calls[0][0].emails).toEqual(first.send.mock.calls[0][0].emails);
  });

  it('counts batches past the 20-hour cutoff and address changes without sending them', async () => {
    const h = harness({
      notifications_take_stale_batch: () => ({
        batch_id: null,
        rows: [],
        stale_unknown: [{ id: 'o-9', kind: 'report_posted', profile_id: 'p-9', reason: 'stale_unknown' }],
        released: 1,
        address_changed: 2,
      }),
    });
    const summary = await runNotifications(ENV, h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dropped: { stale_unknown: 1, address_changed: 2 }, released: 1 });
    expect(h.fnCalls()).toContain('claim_batch');
  });

  it('never calls Resend when not every rendering was stored', async () => {
    const h = harness({ notifications_claim_batch: claiming(2), notifications_store_rendered: () => 1 });

    await expect(runNotifications(ENV, h.deps)).rejects.toThrow(/claim_and_send/);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.argsOf('notifications_mark_batch')).toHaveLength(0);
  });
});

describe('runNotifications: Resend outcomes (BR10.12)', () => {
  it.each([
    [{ kind: 'conflict', status: 409, code: 'invalid_idempotent_request' }, 'conflict'],
    [{ kind: 'in_progress', status: 409, code: 'concurrent_idempotent_requests' }, 'transient'],
    [{ kind: 'transient', status: 503, code: null }, 'transient'],
    [{ kind: 'transient', status: null, code: 'timeout' }, 'transient'],
    [{ kind: 'permanent', status: 422, code: 'validation_error' }, 'permanent'],
    [{ kind: 'auth', status: 401, code: 'invalid_api_key' }, 'release'],
  ] as const)('marks %o as %s and logs the failure with ids only', async (outcome, mark) => {
    const h = harness({ notifications_claim_batch: claiming(2) }, [outcome]);
    const summary = await runNotifications(ENV, h.deps);

    expect((h.argsOf('notifications_mark_batch')[0].p_result as { outcome: string }).outcome).toBe(mark);
    const failure = JSON.parse(h.errors[0]);
    expect(failure).toEqual({
      event: 'notifications-send-failed',
      run_id: 'run-1',
      batch_id: 'batch-1',
      status: outcome.status,
      code: outcome.code,
      outbox_ids: ['row-1', 'row-2'],
    });
    if (mark === 'conflict') expect(summary.idempotent_conflicts).toBe(2);
    else expect(summary.failed).toBe(2);
    // A failed send makes the run partial even though no step threw.
    expect(summary.status).toBe(mark === 'conflict' ? 'ok' : 'partial');
  });

  it('a 429 on the stale batch keeps it and stops the run before a new claim', async () => {
    const h = harness(
      {
        notifications_take_stale_batch: () => ({
          batch_id: 'stale-1',
          rows: [
            {
              id: 's-1',
              profile_id: 'p',
              rendered: { subject: 's', html: 'h', text: 't' },
              to: 'a@example.test',
            },
          ],
          stale_unknown: [],
          released: 0,
          address_changed: 0,
        }),
      },
      [{ kind: 'rate_limited', status: 429, code: 'rate_limit_exceeded' }],
    );
    await runNotifications(ENV, h.deps);

    expect(h.fnCalls()).not.toContain('claim_batch');
    expect(h.argsOf('notifications_mark_batch')[0].p_result).toEqual({
      outcome: 'transient',
      error: '429 rate_limit_exceeded',
    });
  });

  it('the daily quota releases the batch and pauses claims until the next UTC midnight', async () => {
    const h = harness({ notifications_claim_batch: claiming(1) }, [
      { kind: 'quota', status: 429, code: 'daily_quota_exceeded' },
    ]);
    const summary = await runNotifications(ENV, h.deps);

    expect(h.argsOf('notifications_mark_batch')[0].p_result).toEqual({
      outcome: 'release',
      error: '429 daily_quota_exceeded',
    });
    expect(summary.quota_until).toBe('2026-10-25T00:00:00.000Z');
    expect((h.argsOf('notifications_record_run')[0].p_summary as RunSummary).quota_until).toBe(
      summary.quota_until,
    );
  });
});

describe('runNotifications: budget, secrets and CPU (NFR3.1, NFR3.2, NFR5.1)', () => {
  it('makes at most 8 RPCs and 2 Resend calls through real fetch, and logs no key or address', async () => {
    const counts = { rpc: 0, resend: 0 };
    const responses: Record<string, unknown> = {
      notifications_enqueue_reminders: { enqueued: 2, missed_windows: [] },
      notifications_drop_expired: { dropped: [], retention_deleted: 0 },
      notifications_take_stale_batch: {
        batch_id: 'stale-1',
        rows: [
          {
            id: 's-1',
            profile_id: 'p',
            rendered: { subject: 's', html: 'h', text: 't' },
            to: 'a@example.test',
          },
        ],
        stale_unknown: [],
        released: 0,
        address_changed: 0,
      },
      notifications_store_rendered: 50,
      notifications_mark_batch: { outcome: 'sent', updated: 1 },
      notifications_record_run: 'run-row',
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === RESEND_BATCH_URL) {
        counts.resend += 1;
        const body = JSON.parse(String(init?.body)) as unknown[];
        return new Response(JSON.stringify({ data: body.map((_, i) => ({ id: `r-${i}` })) }), {
          status: 200,
        });
      }
      counts.rpc += 1;
      const fn = url.split('/rpc/')[1];
      const headers = init?.headers as Record<string, string>;
      expect(headers.apikey).toBe(SERVICE_KEY);
      expect(headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
      const body =
        fn === 'notifications_claim_batch'
          ? {
              batch_id: JSON.parse(String(init?.body)).p_batch_id,
              rows: claimRows(50),
              dropped: [],
              cap_left: 49,
            }
          : responses[fn];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const lines: string[] = [];
    const summary = await runNotifications(ENV, {
      log: (line) => lines.push(line),
      logError: (line) => lines.push(line),
    });

    expect(summary.sent).toBe(51);
    expect(counts.rpc).toBeLessThanOrEqual(8);
    expect(counts.resend).toBeLessThanOrEqual(2);
    expect(counts).toEqual({ rpc: 8, resend: 2 });
    const logged = lines.join('\n');
    for (const secret of [RESEND_KEY, SERVICE_KEY, '@example.test']) expect(logged).not.toContain(secret);
  });

  it('renders and encodes a full batch of 100 well inside the CPU budget (NFR3.2)', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...PAYLOAD, subsession_id: 9907000 + i }));
    const build = () =>
      JSON.stringify(
        rows.map((payload, i) => ({
          from: DEFAULT_EMAIL_FROM,
          to: [`driver${i}@example.test`],
          ...renderEmail('report_posted', payload, { siteUrl: ENV.SITE_URL, now: NOW }),
        })),
      );
    build(); // warm-up, so the measurement is not the first compile
    const started = performance.now();
    const body = build();
    const elapsed = performance.now() - started;

    expect(body.length).toBeGreaterThan(10_000);
    // The target is 5 ms; the margin keeps a slow CI runner from failing on noise.
    expect(elapsed).toBeLessThan(25);
  });
});

describe('resolveNotificationConfig', () => {
  it('uses the defaults and clamps the numbers', () => {
    expect(resolveNotificationConfig({})).toEqual({
      apiKey: null,
      from: DEFAULT_EMAIL_FROM,
      dailyCap: 100,
      batchSize: 50,
      siteUrl: 'https://alphatouringchallenge.com',
    });
    expect(
      resolveNotificationConfig({ EMAIL_BATCH_SIZE: '500', SITE_URL: 'https://x.example.test/' }),
    ).toMatchObject({
      batchSize: 100,
      siteUrl: 'https://x.example.test',
    });
    expect(resolveNotificationConfig({ EMAIL_BATCH_SIZE: '0', EMAIL_DAILY_CAP: 'abc' })).toMatchObject({
      batchSize: 1,
      dailyCap: 100,
    });
  });
});

describe('admin counts reader (BR10.17, NFR9.3)', () => {
  const raw = {
    queued: 3,
    dropped_7d: 2,
    cap_dropped_7d: 1,
    unknown_7d: 0,
    enqueue_failures_7d: 1,
    last_run_status: 'no_key',
    last_run_at: '2026-10-24T12:45:00+00:00',
  };

  it('reads the counts and turns a no_key run into the "sending is off" flag', () => {
    expect(parseNotificationCounts(raw)).toEqual({
      queued: 3,
      dropped7d: 2,
      capDropped7d: 1,
      unknown7d: 0,
      enqueueFailures7d: 1,
      lastRunStatus: 'no_key',
      lastRunAt: '2026-10-24T12:45:00+00:00',
      sendingOff: true,
    });
    expect(parseNotificationCounts({ ...raw, last_run_status: 'ok' })?.sendingOff).toBe(false);
    expect(parseNotificationCounts({ ...raw, queued: -1 })).toBeNull();
    expect(parseNotificationCounts(null)).toBeNull();
  });

  it('calls the function with the admin token, and returns null instead of throwing on an error', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(raw), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

    expect((await getNotificationCounts(env, 'admin-token'))?.queued).toBe(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/notifications_admin_counts');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('{"message":"NOT_ADMIN"}', { status: 403 }));
    expect(await getNotificationCounts(env, 'driver-token')).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await getNotificationCounts(env, 'admin-token')).toBeNull();
  });
});
