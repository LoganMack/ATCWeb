/**
 * Lineup Changes classification (U9, src/lib/lineups/classify.ts): the season shown, the season before it, and
 * stayed / moved / joined / returning / left from the official rosters only (BR1.3 to BR1.12, US7.2, US7.3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLineups,
  previousSeason,
  resolveLineupSeason,
  type LineupSeason,
  type RosterRow,
} from '../../../src/lib/lineups/classify';

afterEach(() => vi.restoreAllMocks());

const season = (number: number, is_current = false): LineupSeason => ({
  id: `s${number}`,
  number,
  name: `ATC${number}`,
  is_current,
});
const row = (seasonNumber: number, team: string, driver: string): RosterRow => ({
  season_id: `s${seasonNumber}`,
  team_id: team,
  driver_id: driver,
});
const NAMES: Record<string, string> = {
  apex: 'Apex Racing',
  redline: 'Redline',
  volt: 'Volt GP',
  zed: 'zebra',
};
const teamName = (id: string) => NAMES[id] ?? id;

function classify(current: RosterRow[], previous: RosterRow[], earlier: string[] = []) {
  return classifyLineups({ current, previous, earlierDriverIds: new Set(earlier), teamName });
}
const byDriver = (list: ReturnType<typeof classify>) => Object.fromEntries(list.map((c) => [c.driverId, c]));

describe('classifyLineups (BR1.8 to BR1.12)', () => {
  it('marks a driver on the same team in both seasons as stayed', () => {
    const [c] = classify([row(18, 'apex', 'carter')], [row(17, 'apex', 'carter')]);
    expect(c).toEqual({
      driverId: 'carter',
      status: 'stayed',
      returning: false,
      fromTeamId: null,
      toTeamId: 'apex',
    });
  });

  it('marks a driver on different teams as moved, from the old team to the new', () => {
    const [c] = classify([row(18, 'apex', 'ruiz')], [row(17, 'redline', 'ruiz')]);
    expect(c).toMatchObject({ status: 'moved', fromTeamId: 'redline', toTeamId: 'apex' });
  });

  it('marks a driver only on S as joined, and returning when on an earlier roster than S-1', () => {
    const list = byDriver(classify([row(18, 'volt', 'petrov'), row(18, 'volt', 'new')], [], ['petrov']));
    expect(list.petrov).toMatchObject({
      status: 'joined',
      returning: true,
      fromTeamId: null,
      toTeamId: 'volt',
    });
    expect(list.new).toMatchObject({ status: 'joined', returning: false });
  });

  it('marks a driver only on S-1 as left, after every S driver', () => {
    const list = classify([row(18, 'apex', 'carter')], [row(17, 'volt', 'lind'), row(17, 'apex', 'carter')]);
    expect(list.map((c) => c.driverId)).toEqual(['carter', 'lind']);
    expect(list[1]).toMatchObject({ status: 'left', fromTeamId: 'volt', toTeamId: null, returning: false });
  });

  it('ignores a class change and a team rename: the team id is the only input (AC7.2.5)', () => {
    // The rows carry no class, and a renamed team keeps its id, so only teamName would differ.
    const renamed = (id: string) => (id === 'apex' ? 'Apex Racing 2' : teamName(id));
    const list = classifyLineups({
      current: [row(18, 'apex', 'carter')],
      previous: [row(17, 'apex', 'carter')],
      earlierDriverIds: new Set(),
      teamName: renamed,
    });
    expect(list[0].status).toBe('stayed');
  });

  it('keeps the first team by name for a duplicate row and logs ids only (BR1.7)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = classify([row(18, 'zed', 'dup'), row(18, 'apex', 'dup')], [row(17, 'apex', 'dup')]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'stayed', toTeamId: 'apex' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      'Duplicate roster row',
      { seasonId: 's18', driverId: 'dup', teamIds: ['apex', 'zed'] },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Apex Racing|zebra/);
  });

  it('returns nothing for two empty rosters', () => {
    expect(classify([], [])).toEqual([]);
  });
});

describe('resolveLineupSeason (BR1.3, BR1.4)', () => {
  const seasons = [season(16), season(18, true), season(17)];

  it('uses a season asked for by number when it exists', () => {
    expect(resolveLineupSeason('16', seasons, new Set(['s18']))?.number).toBe(16);
  });

  it('uses the current season when it has rosters, for no, unknown or junk values', () => {
    for (const value of [null, '', 'all', '99', '017', 'abc']) {
      expect(resolveLineupSeason(value, seasons, new Set(['s17', 's18']))?.number, String(value)).toBe(18);
    }
  });

  it('falls back to the latest season with rosters when the current one has none', () => {
    expect(resolveLineupSeason(null, seasons, new Set(['s16', 's17']))?.number).toBe(17);
  });

  it('falls back to the current season, else the newest, when no season has rosters', () => {
    expect(resolveLineupSeason(null, seasons, new Set())?.number).toBe(18);
    expect(resolveLineupSeason(null, [season(3), season(5)], new Set())?.number).toBe(5);
    expect(resolveLineupSeason(null, [], new Set())).toBeNull();
  });
});

describe('previousSeason (BR1.5)', () => {
  it('is the highest-numbered season below S, across gaps in the numbering', () => {
    const seasons = [season(10), season(14), season(11)];
    expect(previousSeason(season(14), seasons)?.number).toBe(11);
    expect(previousSeason(season(11), seasons)?.number).toBe(10);
  });

  it('is null for the first season', () => {
    expect(previousSeason(season(1), [season(1), season(2)])).toBeNull();
  });
});
