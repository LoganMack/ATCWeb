/**
 * Collects per-step durations for one request and emits them as a
 * `Server-Timing` header, which browser DevTools draws as separate bars in
 * the request's Network > Timing tab. Diagnostic only: added to measure
 * where /admin's dashboard load time actually goes (auth vs. each Supabase
 * query), without guessing from Supabase's Query Performance page, which
 * only sees time spent inside Postgres.
 *
 * src/middleware.ts creates one per request as `Astro.locals.serverTiming`
 * and only sends the header to signed-in admins, so timing detail never
 * reaches public visitors or the edge cache.
 */
export class ServerTiming {
  private entries: { name: string; ms: number; desc?: string }[] = [];

  /** Record an already-measured duration. */
  add(name: string, ms: number, desc?: string) {
    this.entries.push({ name, ms, desc });
  }

  /**
   * Time a promise from now until it settles (resolved OR rejected), then
   * pass its result through untouched. Wrap each query separately inside a
   * Promise.all so parallel steps each get their own bar.
   */
  time<T>(name: string, promise: Promise<T>, desc?: string): Promise<T> {
    const start = performance.now();
    return promise.finally(() => this.add(name, performance.now() - start, desc));
  }

  /** `name;dur=12.3;desc="..."` entries, comma-separated, per the Server-Timing spec. */
  header(): string {
    return this.entries
      .map(({ name, ms, desc }) => {
        const dur = `${name};dur=${ms.toFixed(1)}`;
        return desc ? `${dur};desc="${desc.replace(/"/g, "'")}"` : dur;
      })
      .join(', ');
  }
}
