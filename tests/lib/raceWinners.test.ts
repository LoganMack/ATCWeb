/**
 * Race winners for the Race Results list (FR4.2, NFR1; BR4.1-BR4.6): one call to race_winners_for_rounds per
 * page, rows grouped by round and race in slot order, and a failed call rendering no winners instead of an
 * error. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RACE_WINNERS_MAX_ROUNDS,
  getRaceWinnersForRounds,
  groupRaceWinners,
  type RaceWinnerRow,
} from '../../src/lib/results/raceWinners';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function driverRow(
  round: number,
  race: number,
  slot: 'alpha' | 'gamma' | 'delta',
  name: string,
): RaceWinnerRow {
  return {
    subsession_id: round,
    race_number: race,
    slot,
    driver_id: `driver-${name}`,
    driver_name: name,
    driver_hidden: false,
    team_id: null,
    team_name: null,
    team_logo_url: null,
  };
}

function teamRow(
  round: number,
  race: number,
  slot: 'alpha_team' | 'delta_team',
  name: string,
): RaceWinnerRow {
  return {
    subsession_id: round,
    race_number: race,
    slot,
    driver_id: null,
    driver_name: null,
    driver_hidden: null,
    team_id: `team-${name}`,
    team_name: name,
    team_logo_url: `https://cdn.example.test/${name}.png`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('groupRaceWinners', () => {
  it('groups by round and race, races ascending, winners in slot order whatever the row order', () => {
    const grouped = groupRaceWinners([
      teamRow(9001, 2, 'alpha_team', 'Red'),
      driverRow(9001, 2, 'alpha', 'Ana'),
      teamRow(9001, 1, 'delta_team', 'Solo'),
      driverRow(9001, 1, 'delta', 'Dee'),
      driverRow(9001, 1, 'alpha', 'Al'),
      teamRow(9001, 1, 'alpha_team', 'Blue'),
      driverRow(9001, 1, 'gamma', 'Gus'),
      driverRow(9002, 1, 'gamma', 'Gil'),
    ]);
    expect([...grouped.keys()]).toEqual([9001, 9002]);
    const round = grouped.get(9001)!;
    expect(round.map((r) => r.raceNumber)).toEqual([1, 2]);
    expect(round[0].winners.map((w) => `${w.slot}=${w.name}`)).toEqual([
      'alpha=Al',
      'gamma=Gus',
      'delta=Dee',
      'alpha_team=Blue',
      'delta_team=Solo',
    ]);
    expect(round[1].winners.map((w) => w.slot)).toEqual(['alpha', 'alpha_team']);
    expect(grouped.get(9002)![0].winners).toHaveLength(1);
  });

  it('keeps the driver and team details each chip needs, and the masked flag', () => {
    const hidden = { ...driverRow(9001, 1, 'alpha', 'Hidden Driver'), driver_hidden: true };
    const [race] = groupRaceWinners([hidden, teamRow(9001, 1, 'alpha_team', 'Red')]).get(9001)!;
    expect(race.winners[0]).toEqual({
      slot: 'alpha',
      kind: 'driver',
      driverId: 'driver-Hidden Driver',
      name: 'Hidden Driver',
      hidden: true,
    });
    expect(race.winners[1]).toEqual({
      slot: 'alpha_team',
      kind: 'team',
      teamId: 'team-Red',
      name: 'Red',
      logoUrl: 'https://cdn.example.test/Red.png',
    });
  });

  it('skips rows missing their driver or team and unknown slots', () => {
    const grouped = groupRaceWinners([
      { ...driverRow(9001, 1, 'alpha', 'Al'), driver_id: null },
      { ...teamRow(9001, 1, 'alpha_team', 'Red'), team_id: null },
      { ...driverRow(9001, 1, 'gamma', 'Gus'), slot: 'beta' as never },
    ]);
    expect(grouped.size).toBe(0);
  });

  it('turns PostgREST bigint ids sent as strings into numbers', () => {
    const row = { ...driverRow(9001, 1, 'alpha', 'Al'), subsession_id: '9001' as unknown as number };
    expect([...groupRaceWinners([row]).keys()]).toEqual([9001]);
  });
});

describe('getRaceWinnersForRounds (NFR1)', () => {
  it('asks once for every listed round and groups the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond([driverRow(9001, 1, 'alpha', 'Al')]));
    vi.stubGlobal('fetch', fetchMock);
    const winners = await getRaceWinnersForRounds(env, [9001, 9002, 9001]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/race_winners_for_rounds');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ p_subsession_ids: [9001, 9002] });
    expect(winners.get(9001)![0].winners[0].name).toBe('Al');
  });

  it('makes no call for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await getRaceWinnersForRounds(env, [])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no winners and logs when the call fails, so the list still renders', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ message: 'boom' }, 500)));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const winners = await getRaceWinnersForRounds(env, [9001]);
    expect(winners.size).toBe(0);
    expect(log).toHaveBeenCalledWith('Failed to load race winners:', expect.any(Error));
  });

  it('never sends more rounds than the function accepts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond([]));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = Array.from({ length: RACE_WINNERS_MAX_ROUNDS + 5 }, (_, i) => 1000 + i);
    await getRaceWinnersForRounds(env, ids);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.p_subsession_ids).toHaveLength(RACE_WINNERS_MAX_ROUNDS);
  });
});
