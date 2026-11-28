/**
 * The Lineup Changes reads (U9, src/lib/lineups/load.ts; NFR1.2, NFR7.3): seven requests in two waves, wave 2
 * skipped when a message applies, the default season, names only from drivers_shown, and a failed read
 * thrown to the fragment. fetch is stubbed; no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSupabaseEnv } from '../../../src/lib/db/client';
import { loadLineups } from '../../../src/lib/lineups/load';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const env = () =>
  resolveSupabaseEnv({
    runtime: {
      env: { PUBLIC_SUPABASE_URL: 'https://db.example.test', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' },
    },
    session: null,
    viewAsVisitor: false,
  } as unknown as App.Locals);

const season = (number: number, is_current = false) => ({
  id: `s${number}`,
  number,
  name: `ATC${number}`,
  is_current,
});
const SEASONS = [season(18, true), season(17), season(16)];
const ROSTERS = [
  { season_id: 's18', team_id: 'apex', driver_id: 'd-carter' },
  { season_id: 's18', team_id: 'apex', driver_id: 'd-ruiz' },
  { season_id: 's17', team_id: 'apex', driver_id: 'd-carter' },
  { season_id: 's17', team_id: 'red', driver_id: 'd-ruiz' },
  { season_id: 's16', team_id: 'red', driver_id: 'd-old' },
];
const TEAMS = [
  { id: 'apex', name: 'Apex', primary_color_hex: '#4369f5', logo_url: null },
  { id: 'red', name: 'Redline', primary_color_hex: null, logo_url: null },
];

/** Answers each REST call from `tables` and records the decoded path. */
function stub(tables: Record<string, unknown>, fail?: string): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.split('/rest/v1/')[1] + url.search);
    paths.push(path);
    const table = path.split('?')[0];
    if (table === fail) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(tables[table] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  return paths;
}

const TABLES = {
  seasons: SEASONS,
  team_rosters: ROSTERS,
  teams: TEAMS,
  drivers_shown: [
    { id: 'd-carter', name: 'Carter', car_number: 7, is_hidden: false },
    { id: 'd-ruiz', name: 'Hidden Driver', car_number: 3, is_hidden: true },
  ],
};

describe('loadLineups', () => {
  it('reads seven times in two waves and masks names through drivers_shown only', async () => {
    const paths = stub(TABLES);
    const board = await loadLineups(env(), '18');
    expect(board.kind).toBe('board');
    expect(paths.map((p) => p.split('?')[0])).toEqual([
      'seasons',
      'team_rosters',
      'teams',
      'team_season_logos',
      'driver_season_car_numbers',
      'driver_season_car_numbers',
      'drivers_shown',
    ]);
    expect(paths[4]).toContain('season_id=eq.s18');
    expect(paths[5]).toContain('season_id=eq.s17');
    expect(paths[6]).toBe('drivers_shown?select=id,name,car_number,is_hidden&id=in.(d-carter,d-ruiz)');
    expect(paths.some((p) => /^drivers\?/.test(p))).toBe(false);
    if (board.kind === 'board') {
      expect(board.noChanges).toBeNull();
      expect(board.teams.map((t) => t.name)).toEqual(['Apex', 'Redline']);
      expect(JSON.stringify(board)).not.toContain('d-ruiz');
    }
  });

  it('skips wave 2 when a message applies', async () => {
    const paths = stub(TABLES);
    expect(await loadLineups(env(), '16')).toEqual({
      kind: 'message',
      text: "ATC16 is the first season, so there's no earlier lineup to compare with.",
    });
    expect(paths).toHaveLength(4);
  });

  it('shows the default season for a missing or unknown season', async () => {
    const rosters = ROSTERS.filter((r) => r.season_id !== 's18');
    stub({ ...TABLES, team_rosters: rosters });
    // ATC18 is current but has no rosters, so ATC17 (compared with ATC16) is shown.
    const board = await loadLineups(env(), 'all');
    expect(board.kind).toBe('board');
    if (board.kind === 'board') expect([board.previousLabel, board.currentLabel]).toEqual(['ATC16', 'ATC17']);
  });

  it('throws when a read fails, so the fragment shows LoadError', async () => {
    stub(TABLES, 'drivers_shown');
    await expect(loadLineups(env(), '18')).rejects.toThrow(/drivers_shown/);
  });
});
