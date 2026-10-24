/**
 * One scheduled notifications run (every 15 minutes; BR10.6-BR10.13, BR10.19, BR10.20). The steps run in
 * order, each in its own try/catch so one failure is logged and the rest still run: enqueue reminders,
 * drop expired rows, stop if RESEND_API_KEY is missing, re-send one stale batch, claim and send one new
 * batch, then record the run and log one summary line. At most 8 RPCs and 2 Resend calls. Logs carry ids,
 * kinds and reasons only, never an address or the key.
 */
import { createServiceDb, type NotificationEnv, type ServiceDb } from './db';
import { sendBatch, type OutgoingEmail, type SendBatchInput, type SendOutcome } from './sender';
import { renderEmail, type NotificationKind, type RenderedEmail } from './templates';

export const DEFAULT_EMAIL_FROM = 'Alpha Touring Challenge <noreply@alphatouringchallenge.com>';
export const DEFAULT_SITE_URL = 'https://alphatouringchallenge.com';

export interface NotificationConfig {
  apiKey: string | null;
  from: string;
  dailyCap: number;
  batchSize: number;
  siteUrl: string;
}

function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export function resolveNotificationConfig(env: NotificationEnv): NotificationConfig {
  return {
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM,
    dailyCap: intVar(env.EMAIL_DAILY_CAP, 100, 0, 100_000),
    batchSize: intVar(env.EMAIL_BATCH_SIZE, 50, 1, 100),
    siteUrl: (env.SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, ''),
  };
}

export interface RunSummary {
  event: 'notifications-run';
  run_id: string;
  status: 'ok' | 'no_key' | 'partial';
  enqueued: number;
  missed_windows: string[];
  dropped: Record<string, number>;
  released: number;
  resent_batch: string | null;
  claimed: number;
  batch_size: number;
  sent: number;
  failed: number;
  idempotent_conflicts: number;
  cap_left: number | null;
  retention_deleted: number;
  quota_until: string | null;
  failed_steps: string[];
  duration_ms: number;
}

export interface RunDeps {
  db: ServiceDb;
  now: () => Date;
  newId: () => string;
  send: (input: SendBatchInput) => Promise<SendOutcome>;
  log: (line: string) => void;
  logError: (line: string) => void;
}

interface DroppedRow {
  id: string;
  kind: string;
  profile_id: string;
  reason: string;
}

interface BatchRow {
  id: string;
  to: string;
  email: RenderedEmail;
}

interface ClaimResult {
  batch_id: string;
  rows: {
    id: string;
    kind: NotificationKind;
    profile_id: string;
    payload: Record<string, unknown>;
    to: string;
  }[];
  dropped: DroppedRow[];
  cap_left: number;
}

interface StaleResult {
  batch_id: string | null;
  rows: { id: string; profile_id: string; rendered: RenderedEmail; to: string }[];
  stale_unknown: DroppedRow[];
  released: number;
  address_changed: number;
}

function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
}

/** Runs the steps; the run's own `failed_steps` and `status` say what went wrong. */
class NotificationRun {
  readonly summary: RunSummary;
  private stopped = false;

  constructor(
    private readonly config: NotificationConfig,
    private readonly deps: RunDeps,
    runId: string,
  ) {
    this.summary = {
      event: 'notifications-run',
      run_id: runId,
      status: 'ok',
      enqueued: 0,
      missed_windows: [],
      dropped: {},
      released: 0,
      resent_batch: null,
      claimed: 0,
      batch_size: config.batchSize,
      sent: 0,
      failed: 0,
      idempotent_conflicts: 0,
      cap_left: null,
      retention_deleted: 0,
      quota_until: null,
      failed_steps: [],
      duration_ms: 0,
    };
  }

  async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.summary.failed_steps.push(name);
      this.deps.logError(
        JSON.stringify({
          event: 'notifications-step-failed',
          run_id: this.summary.run_id,
          step: name,
          error: errorText(err),
        }),
      );
    }
  }

  private noteDrops(rows: DroppedRow[] | undefined): void {
    for (const row of rows ?? []) {
      this.summary.dropped[row.reason] = (this.summary.dropped[row.reason] ?? 0) + 1;
      this.deps.log(
        JSON.stringify({
          event: 'notifications-dropped',
          run_id: this.summary.run_id,
          outbox_id: row.id,
          kind: row.kind,
          profile_id: row.profile_id,
          reason: row.reason,
        }),
      );
    }
  }

  async enqueueReminders(): Promise<void> {
    const result = await this.deps.db.rpc<{ enqueued: number; missed_windows: string[] }>(
      'notifications_enqueue_reminders',
    );
    this.summary.enqueued = result.enqueued;
    this.summary.missed_windows = result.missed_windows ?? [];
  }

  async dropExpired(): Promise<void> {
    const result = await this.deps.db.rpc<{ dropped: DroppedRow[]; retention_deleted: number }>(
      'notifications_drop_expired',
      { p_daily_cap: this.config.dailyCap },
    );
    this.noteDrops(result.dropped);
    this.summary.retention_deleted = result.retention_deleted;
  }

  async resendStale(): Promise<void> {
    const stale = await this.deps.db.rpc<StaleResult>('notifications_take_stale_batch');
    this.noteDrops(stale.stale_unknown);
    this.summary.released += stale.released;
    if (stale.address_changed > 0) {
      this.summary.dropped.address_changed =
        (this.summary.dropped.address_changed ?? 0) + stale.address_changed;
    }
    if (!stale.batch_id || stale.rows.length === 0) return;
    this.summary.resent_batch = stale.batch_id;
    await this.deliver(
      stale.batch_id,
      stale.rows.map((r) => ({ id: r.id, to: r.to, email: r.rendered })),
    );
  }

  async claimAndSend(): Promise<void> {
    if (this.stopped) return;
    const batchId = this.deps.newId();
    const claim = await this.deps.db.rpc<ClaimResult>('notifications_claim_batch', {
      p_batch_id: batchId,
      p_batch_size: this.config.batchSize,
      p_daily_cap: this.config.dailyCap,
    });
    this.noteDrops(claim.dropped);
    this.summary.cap_left = claim.cap_left;
    if (claim.rows.length === 0) return;
    this.summary.claimed = claim.rows.length;

    const context = { siteUrl: this.config.siteUrl, now: this.deps.now() };
    const rows = claim.rows.map((r) => ({
      id: r.id,
      to: r.to,
      email: renderEmail(r.kind, r.payload, context),
    }));
    const stored = await this.deps.db.rpc<number>('notifications_store_rendered', {
      p_batch_id: batchId,
      p_rendered: rows.map((r) => ({ id: r.id, rendered: r.email })),
    });
    // Never send what is not stored: a later stale run must be able to re-send the same bytes.
    if (stored !== rows.length)
      throw new Error(`stored ${stored} of ${rows.length} renderings for batch ${batchId}`);
    await this.deliver(batchId, rows);
  }

  private async mark(batchId: string, result: Record<string, unknown>): Promise<void> {
    await this.deps.db.rpc('notifications_mark_batch', { p_batch_id: batchId, p_result: result });
  }

  /** Sends one batch and marks it; a 429, a quota or a refused key stops the run's sending. */
  private async deliver(batchId: string, rows: BatchRow[]): Promise<void> {
    const emails: OutgoingEmail[] = rows.map((r) => ({ to: r.to, ...r.email }));
    const outcome = await this.deps.send({
      apiKey: this.config.apiKey ?? '',
      from: this.config.from,
      batchId,
      emails,
    });
    const ids = rows.map((r) => r.id);
    if (outcome.kind === 'sent') {
      const providerIds = ids.map((id, i) => ({ id, provider_id: outcome.providerIds[i] ?? null }));
      await this.mark(batchId, { outcome: 'sent', provider_ids: providerIds });
      this.summary.sent += ids.length;
      return;
    }

    const error = [outcome.status ?? 'no_response', outcome.code].filter(Boolean).join(' ');
    this.deps.logError(
      JSON.stringify({
        event: 'notifications-send-failed',
        run_id: this.summary.run_id,
        batch_id: batchId,
        status: outcome.status,
        code: outcome.code,
        outbox_ids: ids,
      }),
    );
    if (outcome.kind === 'conflict') {
      this.summary.idempotent_conflicts += ids.length;
      await this.mark(batchId, { outcome: 'conflict', error });
      return;
    }
    this.summary.failed += ids.length;
    if (outcome.kind === 'permanent') return this.mark(batchId, { outcome: 'permanent', error });
    if (outcome.kind === 'quota' || outcome.kind === 'auth') {
      this.stopped = true;
      if (outcome.kind === 'quota') this.summary.quota_until = nextUtcMidnight(this.deps.now());
      return this.mark(batchId, { outcome: 'release', error });
    }
    if (outcome.kind === 'rate_limited') this.stopped = true;
    await this.mark(batchId, { outcome: 'transient', error });
  }

  async record(): Promise<void> {
    await this.deps.db.rpc('notifications_record_run', { p_summary: this.summary });
  }
}

function resolveDeps(env: NotificationEnv, overrides: Partial<RunDeps>): RunDeps {
  return {
    db: overrides.db ?? createServiceDb(env),
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => crypto.randomUUID()),
    send: overrides.send ?? sendBatch,
    log: overrides.log ?? ((line) => console.log(line)),
    logError: overrides.logError ?? ((line) => console.error(line)),
  };
}

/**
 * The scheduled handler's work. Resolves with the summary; rejects after logging when a step failed, so
 * the cron invocation shows as failed in Cloudflare.
 */
export async function runNotifications(
  env: NotificationEnv,
  overrides: Partial<RunDeps> = {},
): Promise<RunSummary> {
  const deps = resolveDeps(env, overrides);
  const config = resolveNotificationConfig(env);
  const started = deps.now().getTime();
  const run = new NotificationRun(config, deps, deps.newId());

  await run.step('enqueue_reminders', () => run.enqueueReminders());
  await run.step('drop_expired', () => run.dropExpired());
  if (config.apiKey) {
    await run.step('resend_stale', () => run.resendStale());
    await run.step('claim_and_send', () => run.claimAndSend());
  }

  const { summary } = run;
  // A refused key, quota or rate limit fails no step, so failed sends also make the run partial.
  summary.status =
    !config.apiKey ? 'no_key' : summary.failed_steps.length > 0 || summary.failed > 0 ? 'partial' : 'ok';
  summary.duration_ms = deps.now().getTime() - started;
  await run.step('record_run', () => run.record());
  if (summary.failed_steps.includes('record_run') && summary.status === 'ok') summary.status = 'partial';
  deps.log(JSON.stringify(summary));
  if (summary.failed_steps.length > 0) {
    throw new Error(`notifications run ${summary.run_id} failed in: ${summary.failed_steps.join(', ')}`);
  }
  return summary;
}
