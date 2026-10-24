/**
 * The Worker's handlers (U7: BR10.16, NFR3.4, NFR8.3; contract C9), built by createWorker around an injected
 * fake Astro handler, so no test needs the build output: `fetch` passes through unchanged and does no other
 * work, and `scheduled` runs the notifications under waitUntil and returns the same run.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/lib/notifications/worker';
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
    const worker = createWorker({ fetch: () => new Response('') }, run);
    const { ctx, waited } = context();

    const result = worker.scheduled(controller, env, ctx);

    expect(run).toHaveBeenCalledWith(env);
    expect(waited).toEqual([result]);
    await expect(result).resolves.toEqual({ status: 'ok' });
  });

  it('lets a failed run fail the scheduled invocation', async () => {
    const failure = Promise.reject(new Error('notifications run run-1 failed in: claim_and_send'));
    failure.catch(() => {});
    const worker = createWorker({ fetch: () => new Response('') }, () => failure);
    const { ctx, waited } = context();

    await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow(/claim_and_send/);
    expect(waited).toEqual([failure]);
  });
});
