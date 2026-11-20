/**
 * The Worker's handlers (U7: BR10.16, NFR3.4, NFR8.3; contract C9), built by createWorker around an injected
 * fake Astro handler, so no test needs the build output: `fetch` passes through unchanged and does no other
 * work, and `scheduled` runs the notifications under waitUntil and returns the same run.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/lib/notifications/worker';
import { runPendingRatings } from '../../src/lib/rating/serviceRun';
import type { ExecutionContext, ScheduledController } from '../../src/lib/notifications/workerTypes';

const env = { PUBLIC_SUPABASE_URL: 'https://project.example.test' };
const controller: ScheduledController = { scheduledTime: 0, cron: '*/15 * * * *', noRetry: () => {} };

function context() {
  const waited: Promise<unknown>[] = [];
  const ctx: ExecutionContext = { waitUntil: (p) => void waited.push(p), passThroughOnException: () => {} };
  return { ctx, waited };
}

describe('createWorker', () => {
  it('passes the request, env and context to Astro unchanged and returns its response', async () => {
    const response = new Response('astro page');
    const astroFetch = vi.fn((_request: Request, _env: typeof env, _ctx: ExecutionContext) => response);
    const run = vi.fn(async () => 'run');
    const worker = createWorker({ fetch: astroFetch }, run);
    const request = new Request('https://site.example.test/standings');
    const { ctx } = context();

    expect(await worker.fetch(request, env, ctx)).toBe(response);
    expect(astroFetch).toHaveBeenCalledTimes(1);
    expect(astroFetch.mock.calls[0][0]).toBe(request);
    expect(astroFetch.mock.calls[0][1]).toBe(env);
    expect(astroFetch.mock.calls[0][2]).toBe(ctx);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the handler as `this`, as Astro’s own export expects', async () => {
    const handler = {
      label: 'astro',
      fetch(this: { label: string }) {
        return new Response(this.label);
      },
    };
    const worker = createWorker(handler, async () => null);
    const { ctx } = context();
    expect(await (await worker.fetch(new Request('https://site.example.test/'), env, ctx)).text()).toBe(
      'astro',
    );
  });

  it('runs the notifications with the env under waitUntil and returns that same run', async () => {
    const run = vi.fn(async (_env: typeof env) => ({ status: 'ok' }));
    const ratings = vi.fn(async () => ({ status: 'idle' }));
    const worker = createWorker({ fetch: () => new Response('') }, run, ratings);
    const { ctx, waited } = context();

    const result = worker.scheduled(controller, env, ctx);

    expect(run).toHaveBeenCalledWith(env);
    // The notifications run first, then the Series iRating run beside it (BR2.6).
    expect(waited).toHaveLength(2);
    expect(waited[0]).toBe(result);
    await expect(result).resolves.toEqual({ status: 'ok' });
  });

  it('lets a failed run fail the scheduled invocation', async () => {
    const failure = Promise.reject(new Error('notifications run run-1 failed in: claim_and_send'));
    failure.catch(() => {});
    const worker = createWorker({ fetch: () => new Response('') }, () => failure, async () => null);
    const { ctx, waited } = context();

    await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow(/claim_and_send/);
    expect(waited[0]).toBe(failure);
  });

  it('runs the Series iRating catch-up with the same env on every scheduled run (points-calc BR2.6)', async () => {
    const ratings = vi.fn(async (_env: typeof env) => ({ status: 'ok', races: 2 }));
    const worker = createWorker({ fetch: () => new Response('') }, async () => 'sent', ratings);
    const { ctx, waited } = context();

    await worker.scheduled(controller, env, ctx);

    expect(ratings).toHaveBeenCalledWith(env);
    await expect(waited[1]).resolves.toEqual({ status: 'ok', races: 2 });
  });

  it('keeps the notifications running when the ratings run rejects or throws, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const ratings of [
        async () => {
          throw new Error('rating_process_pending timed out');
        },
        () => {
          throw new Error('thrown before any promise');
        },
      ]) {
        const run = vi.fn(async () => 'sent');
        const worker = createWorker({ fetch: () => new Response('') }, run, ratings);
        const { ctx, waited } = context();
        await expect(worker.scheduled(controller, env, ctx)).resolves.toBe('sent');
        await expect(waited[1]).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledTimes(1);
      }
      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[0][0])).toContain('series ratings');
    } finally {
      error.mockRestore();
    }
  });

  it('starts the ratings run even when the notifications run fails', async () => {
    const failure = Promise.reject(new Error('notifications down'));
    failure.catch(() => {});
    const ratings = vi.fn(async () => ({ status: 'idle' }));
    const worker = createWorker({ fetch: () => new Response('') }, () => failure, ratings);
    const { ctx } = context();
    await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow(/notifications down/);
    expect(ratings).toHaveBeenCalledTimes(1);
  });
});

describe('runPendingRatings (points-calc BR2.6)', () => {
  it('calls rating_process_pending and returns its result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ status: 'ok', races: 3, ms: 41 }));
    await expect(runPendingRatings(env, { rpc } as never)).resolves.toEqual({ status: 'ok', races: 3, ms: 41 });
    expect(rpc).toHaveBeenCalledWith('rating_process_pending');
    expect(log).toHaveBeenCalledWith('series ratings: rated 3 races in 41 ms');
    log.mockRestore();
  });

  it('never throws: a failed call is reported as failed, and a recorded error is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = vi.fn(async () => {
      throw new Error('Supabase rpc error 503');
    });
    await expect(runPendingRatings(env, { rpc: down } as never)).resolves.toEqual({
      status: 'failed',
      error: 'Supabase rpc error 503',
    });
    const failed = vi.fn(async () => ({ status: 'error', error: 'canceling statement due to statement timeout' }));
    await expect(runPendingRatings(env, { rpc: failed } as never)).resolves.toMatchObject({ status: 'error' });
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('treats an empty answer as idle', async () => {
    const rpc = vi.fn(async () => null);
    await expect(runPendingRatings(env, { rpc } as never)).resolves.toEqual({ status: 'idle' });
  });
});
