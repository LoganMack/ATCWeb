/**
 * The two Workers runtime types the scheduled handler needs, declared here so the type checks and the
 * tests need no extra dependency.
 */

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
