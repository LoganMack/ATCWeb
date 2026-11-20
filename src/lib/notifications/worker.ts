/**
 * The Worker's two handlers (ADR-006, BR10.16), built around the Astro handler so src/worker/entry.ts stays
 * three lines and this stays testable without a build: `fetch` passes the request, env and context to
 * Astro unchanged, and `scheduled` runs the notifications under waitUntil and also returns the run, so a
 * failed run marks the cron invocation as failed. The same cron also runs the Series iRating catch-up
 * (BR2.6) beside it, under its own waitUntil: the two are independent, so one failing never stops the other,
 * and the returned promise is still the notifications run's alone.
 */
import { runPendingRatings } from '../rating/serviceRun';
import type { NotificationEnv } from './db';
import type { ExecutionContext, ScheduledController } from './workerTypes';

export interface FetchHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface WorkerHandlers<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<unknown>;
}

export function createWorker<Env extends NotificationEnv>(
  astro: FetchHandler<Env>,
  runNotifications: (env: Env) => Promise<unknown>,
  runRatings: (env: Env) => Promise<unknown> = runPendingRatings,
): WorkerHandlers<Env> {
  return {
    fetch(request, env, ctx) {
      return astro.fetch(request, env, ctx);
    },
    scheduled(_controller, env, ctx) {
      // Started first and caught here, so neither a throw nor a rejection can reach the notifications run.
      let ratings: Promise<unknown>;
      try {
        ratings = Promise.resolve(runRatings(env)).catch((err) =>
          console.error('series ratings: the scheduled run failed:', err),
        );
      } catch (err) {
        console.error('series ratings: the scheduled run failed:', err);
        ratings = Promise.resolve();
      }
      const run = runNotifications(env);
      ctx.waitUntil(run);
      ctx.waitUntil(ratings);
      return run;
    },
  };
}
