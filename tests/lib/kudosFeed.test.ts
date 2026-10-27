/**
 * Kudos across rounds (driver-profile-polish FR6, FR7): the driver's kudos and the season feed read the masked
 * kudos_shown view, newest first, and their cars come in car-number order with hidden drivers flagged. Also
 * the "ATC17, Round 4" label and the round numbering behind it. fetch is stubbed; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDriverKudos } from '../../src/lib/driverPage/kudos';
import {
  getKudosForSubsessions,
  getKudosInvolvingDriver,
  kudosSessionLabel,
  toKudosEntries,
  type KudosFeedRow,
} from '../../src/lib/kudos';
import { seasonRoundLabel } from '../../src/lib/roundLabels';
import { buildRoundContexts } from '../../src/lib/roundContext';
import type { RoundSummary } from '../../src/lib/results/rows';
import type { SupabaseEnv } from '../../src/lib/db/client';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const ENV: SupabaseEnv = { url: 'https://db.example.test', anonKey: 'anon-key' };
const DRIVER_ID = '99999999-0000-0000-0000-000000000601';

function stubFetch(answer: unknown, status = 200): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(decodeURIComponent(String(input)));
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return urls;
}

function row(overrides: Partial<KudosFeedRow> = {}): KudosFeedRow {
  return {
    id: 'k1',
    subsession_id: 100,
    session: 'race:2',
    lap: 3,
    turn: '1',
    description: null,
    clip_url: null,
    author_id: 'a1',
    author_name: 'Author',
    created_at: '2026-10-01T18:00:00Z',
    kudos_drivers: [],
    ...overrides,
  };
}

describe('toKudosEntries', () => {
  it('orders cars by number and keeps a hidden driver flagged with its masked name', () => {
    const [entry] = toKudosEntries([
      row({
        kudos_drivers: [
          { driver_id: 'd9', drivers: { id: 'd9', name: 'Zed', car_number: 9, is_hidden: false } },
          { driver_id: 'd2', drivers: { id: 'd2', name: 'Hidden Driver', car_number: 2, is_hidden: true } },
          { driver_id: 'dx', drivers: { id: 'dx', name: 'No Number', car_number: null, is_hidden: false } },
        ],
      }),
    ]);
    expect(entry.cars.map((c) => c.id)).toEqual(['d2', 'd9', 'dx']);
    expect(entry.cars[0]).toMatchObject({ name: 'Hidden Driver', is_hidden: true });
    expect(entry).not.toHaveProperty('kudos_drivers');
  });

  it('drops a car whose driver row is gone, and handles an empty list', () => {
    const [entry] = toKudosEntries([row({ kudos_drivers: [{ driver_id: 'gone', drivers: null }] })]);
    expect(entry.cars).toEqual([]);
    expect(toKudosEntries([])).toEqual([]);
  });
});

describe('kudos reads', () => {
  it('filters the driver’s kudos through the inner alias, newest first, on kudos_shown', async () => {
    const urls = stubFetch([row()]);
    const entries = await getKudosInvolvingDriver(ENV, DRIVER_ID);
    expect(entries).toHaveLength(1);
    expect(urls[0]).toContain('/rest/v1/kudos_shown?select=');
    expect(urls[0]).toContain('involved_match:kudos_drivers!inner(driver_id)');
    expect(urls[0]).toContain(`involved_match.driver_id=eq.${DRIVER_ID}`);
    expect(urls[0]).toContain('order=created_at.desc');
  });

  it('reads nothing for a malformed driver id or an empty round list', async () => {
    const urls = stubFetch([]);
    expect(await getKudosInvolvingDriver(ENV, 'not-a-uuid')).toEqual([]);
    expect(await getKudosForSubsessions(ENV, [])).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('reads a season’s kudos in one call', async () => {
    const urls = stubFetch([]);
    await getKudosForSubsessions(ENV, [1, 2, 2]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('subsession_id=in.(1,2)');
    expect(urls[0]).toContain('drivers:drivers_shown(id,name,car_number,is_hidden)');
  });

  it('surfaces a failed read as a throw', async () => {
    stubFetch('boom', 500);
    await expect(getKudosInvolvingDriver(ENV, DRIVER_ID)).rejects.toThrow(/Supabase REST error 500/);
  });
});

describe('loadDriverKudos (the profile button, FR6.1, FR6.4)', () => {
  /** Answers each REST call by table; records the tables read. */
  function stubTables(answers: Record<string, unknown>): string[] {
    const tables: string[] = [];
    globalThis.fetch = (async (input: string) => {
      const table = new URL(String(input)).pathname.split('/rest/v1/')[1];
      tables.push(table);
      return new Response(JSON.stringify(answers[table] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    return tables;
  }

  it('lists the driver’s kudos with their rounds, leaving out a kudos whose round is not listed', async () => {
    stubTables({
      drivers_shown: [{ id: DRIVER_ID, profile_private: false }],
      kudos_shown: [row({ id: 'k1', subsession_id: 100 }), row({ id: 'k2', subsession_id: 999 })],
      curated_rounds: [
        {
          subsession_id: 100,
          season_id: 's',
          season_label: 'ATC17',
          start_time: '2026-01-01T00:00:00Z',
          track_name: 'Spa',
        },
      ],
    });
    const result = await loadDriverKudos(ENV, DRIVER_ID);
    expect(result.entries.map((e) => e.id)).toEqual(['k1']);
    expect(result.rounds.get(100)?.label).toBe('ATC17, Round 1');
  });

  it('reads no kudos for a private profile or an unknown driver', async () => {
    let tables = stubTables({ drivers_shown: [{ id: DRIVER_ID, profile_private: true }] });
    expect(await loadDriverKudos(ENV, DRIVER_ID)).toMatchObject({ privateProfile: true, entries: [] });
    expect(tables).not.toContain('kudos_shown');
    tables = stubTables({ drivers_shown: [] });
    expect(await loadDriverKudos(ENV, DRIVER_ID)).toMatchObject({ notFound: true });
    expect(tables).not.toContain('kudos_shown');
  });

  it('reports a failed read as a load error without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch('down', 503);
    expect(await loadDriverKudos(ENV, DRIVER_ID)).toMatchObject({ loadError: true, entries: [] });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('labels', () => {
  it('reads "ATC17, Round 4", or the exhibition wording with no number', () => {
    expect(seasonRoundLabel('ATC17', 4)).toBe('ATC17, Round 4');
    expect(seasonRoundLabel('ATC17', null)).toBe('ATC17, Exhibition');
    expect(seasonRoundLabel(null, 2)).toBe('Round 2');
  });

  it('names the session of a kudos', () => {
    expect(kudosSessionLabel('race:2')).toBe('Race 2');
    expect(kudosSessionLabel('qualifying:0')).toBe('Qualifying');
    expect(kudosSessionLabel('practice:0')).toBe('Practice');
  });

  it('numbers rounds per season and leaves excluded rounds unnumbered', () => {
    const round = (id: number, season: string, start: string): RoundSummary => ({
      subsession_id: id,
      season_id: season,
      season_label: season.toUpperCase(),
      start_time: start,
      track_name: `Track ${id}`,
      round_number: null,
      format: null,
      strength_of_field: null,
      num_drivers: null,
    });
    const contexts = buildRoundContexts(
      [
        round(1, 'atc17', '2026-01-01T00:00:00Z'),
        round(2, 'atc17', '2026-01-08T00:00:00Z'),
        round(3, 'atc17', '2026-01-15T00:00:00Z'),
        round(4, 'atc18', '2026-06-01T00:00:00Z'),
      ],
      new Set([2]),
    );
    expect(contexts.get(1)?.label).toBe('ATC17, Round 1');
    expect(contexts.get(2)?.label).toBe('ATC17, Exhibition');
    expect(contexts.get(3)?.label).toBe('ATC17, Round 2');
    expect(contexts.get(4)).toMatchObject({ label: 'ATC18, Round 1', trackName: 'Track 4' });
  });
});
