/**
 * The driver profile's fragments answer an id that isn't a known driver with a 404 before any heavy read:
 * nothing at all for a non-UUID, and only the driver check (plus the light reads beside it) for an unknown
 * UUID, never the awards history or the race history. The shared fetch helper is stubbed; no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseEnv } from '../../src/lib/db/client';
import { loadDriverAwards, loadDriverPage } from '../../src/lib/driverPage/load';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const PAGES = raw(
  import.meta.glob('/src/pages/drivers/**/*.astro', { query: '?raw', import: 'default', eager: true }),
);

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const env: SupabaseEnv = { url: 'https://example.invalid', anonKey: 'anon' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

/** Every read answers an empty list; returns the tables read. */
function stubEmpty(): string[] {
  const tables: string[] = [];
  globalThis.fetch = (async (url: string) => {
    tables.push(decodeURIComponent(String(url)).split('/rest/v1/')[1].split('?')[0]);
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return tables;
}

describe("the driver fragments' 404 for an unknown driver", () => {
  it('answers a non-UUID id without reading anything', async () => {
    const tables = stubEmpty();
    for (const id of ['not-a-uuid', '', "1' or '1'='1", `${UNKNOWN}x`]) {
      expect(await loadDriverAwards(env, id)).toMatchObject({ notFound: true, awardEntries: [] });
      expect((await loadDriverPage(env, id)).notFound).toBe(true);
    }
    expect(tables).toEqual([]);
  });

  it('answers an unknown UUID after the driver check, without the awards or race history', async () => {
    const tables = stubEmpty();
    expect(await loadDriverAwards(env, UNKNOWN)).toMatchObject({ notFound: true, loadError: null });
    expect((await loadDriverPage(env, UNKNOWN)).notFound).toBe(true);
    // The driver check reads the masked view (U4).
    expect(tables).toContain('drivers_shown');
    // The heavy reads: every score row (awards history, race history), the stored stats, the incidents.
    for (const heavy of [
      'race_score_results_public',
      'curated_race_results_shown',
      'round_driver_stats',
      'penalties_shown',
    ]) {
      expect(tables, heavy).not.toContain(heavy);
    }
  });

  it('turns notFound into an uncached 404 in both fragments', () => {
    const notFound =
      "if (notFound) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });";
    expect(PAGES['/src/pages/drivers/[id]/awards.astro']).toContain(notFound);
    expect(PAGES['/src/pages/drivers/[id]/fragment.astro']).toContain(notFound);
  });
});
