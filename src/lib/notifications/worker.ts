/**
 * The Worker's two handlers (ADR-006, BR10.16), built around the Astro handler so src/worker/entry.ts stays
 * three lines and this stays testable without a build: `fetch` passes the request, env and context to
 * Astro unchanged, and `scheduled` runs the notifications under waitUntil and also returns the run, so a
 * failed run marks the cron invocation as failed.
 */
import type { ExecutionContext, ScheduledController } from './workerTypes';

export interface FetchHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface WorkerHandlers<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<unknown>;
}

export function createWorker<Env>(
  astro: FetchHandler<Env>,
  runNotifications: (env: Env) => Promise<unknown>,
): WorkerHandlers<Env> {
  return {
    fetch(request, env, ctx) {
      return astro.fetch(request, env, ctx);
    },
    scheduled(_controller, env, ctx) {
      const run = runNotifications(env);
      ctx.waitUntil(run);
      return run;
    },
  };
}
