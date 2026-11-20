/**
 * The points calculator's loader (src/lib/calculator/load.ts; BR3.1, BR3.12, BR3.13, FR2.6): the reads are
 * stubbed module by module, so these check what the loader builds from them: masked names and keys, remaining
 * rounds from the calendar events, special rounds, the championship and season fallbacks, the live fallback
 * when the stored round stats are incomplete, and team entrants with their members.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Season } from '../../src/lib/db/seasons';
import type { DriverBasic, ScoreRow } from '../../src/lib/results/rows';
import type { DriverSeasonStanding, StandingsRoundStat } from '../../src/lib/results/standingsCore';
import type { SeasonCalendarEvent } from '../../src/lib/db/events';

const mocks = vi.hoisted(() => ({
  getSeasons: vi.fn(),
  getScoringRulesets: vi.fn(),
  getDriverClasses: vi.fn(),
  getStandingsExcludedRoundIds: vi.fn(),
  driversSelect: vi.fn(),
  getRaceScoresForSeasonOverall: vi.fn(),
  getTeamsBasic: vi.fn(),
  getRacePointsForSeason: vi.fn(),
  getSeasonCalendarEvents: vi.fn(),
  getRoundsForSeason: vi.fn(),
  loadStoredSeasons: vi.fn(),
  classStandingsFromRounds: vi.fn(),
  overallStandingsFromRounds: vi.fn(),
  computeSeasonStandings: vi.fn(),
  computeOverallSeasonStandings: vi.fn(),
}));

vi.mock('../../src/lib/db/seasons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/db/seasons')>()),
  getSeasons: mocks.getSeasons,
  getScoringRulesets: mocks.getScoringRulesets,
}));
vi.mock('../../src/lib/db/lookups', () => ({ getDriverClasses: mocks.getDriverClasses }));
vi.mock('../../src/lib/db/rounds', () => ({
  getStandingsExcludedRoundIds: mocks.getStandingsExcludedRoundIds,
}));
vi.mock('../../src/lib/db/events', () => ({ getSeasonCalendarEvents: mocks.getSeasonCalendarEvents }));
vi.mock('../../src/lib/results/rounds', () => ({ getRoundsForSeason: mocks.getRoundsForSeason }));
vi.mock('../../src/lib/results/rows', () => ({
  driversSelect: mocks.driversSelect,
  getRaceScoresForSeasonOverall: mocks.getRaceScoresForSeasonOverall,
  getTeamsBasic: mocks.getTeamsBasic,
  getRacePointsForSeason: mocks.getRacePointsForSeason,
}));
vi.mock('../../src/lib/results/roundStatsAdapter', () => ({
  loadStoredSeasons: mocks.loadStoredSeasons,
  classStandingsFromRounds: mocks.classStandingsFromRounds,
  overallStandingsFromRounds: mocks.overallStandingsFromRounds,
}));
vi.mock('../../src/lib/results/standings', () => ({
  computeSeasonStandings: mocks.computeSeasonStandings,
  computeOverallSeasonStandings: mocks.computeOverallSeasonStandings,
}));

const { loadCalculatorSeason, resolveChampionship, resolveCalculatorSeason, availableChampionships } =
  await import('../../src/lib/calculator/load');

const env = { url: 'https://project.example.test', anonKey: 'anon' };
const HIDDEN_ID = '99999999-0000-0000-0000-000000000001';

function season(over: Partial<Season> = {}): Season {
  return {
    id: 's18',
    number: 18,
    name: 'ATC18',
    logo_url: null,
    logo_url_light: null,
    start_date: null,
    end_date: null,
    is_current: true,
    extra_drop_weeks: 0,
    scoring_ruleset_id: 'r1',
    gamma_enabled: true,
    delta_enabled: true,
    delta_team_enabled: false,
    ...over,
  };
}

const RULES = {
  base_points: { endurance: [200, 190, 180], sprint: [100, 95, 90] },
  classified_minimum: { endurance: 6, sprint: 3 },
  drops: { base: 2 },
};

function driver(id: string, name: string, hidden = false, cust: number | null = 100): DriverBasic {
  return {
    id,
    name,
    car_number: null,
    photo_url: null,
    iracing_cust_id: hidden ? -4242 : cust,
    is_rookie: false,
    nationality_1: null,
    nationality_2: null,
    is_ai: false,
    is_hidden: hidden,
  };
}

function standing(d: DriverBasic, cells: [number, number][]): DriverSeasonStanding {
  const stat = (): StandingsRoundStat => ({
    wins: 0,
    podiums: 0,
    top5s: 0,
    top10s: 0,
    poles: 0,
    starts: 1,
    lapsLed: 0,
    laps: 10,
  });
  return {
    driver: d,
    position: 1,
    totalPoints: cells.reduce((s, [, p]) => s + p, 0),
    starts: cells.length,
    appearances: cells.length,
    wins: 0,
    podiums: 0,
    top5s: 0,
    top10s: 0,
    poles: 0,
    lapsLed: 0,
    laps: 10 * cells.length,
    roundCells: new Map(cells.map(([id, points]) => [id, { points, dropped: false, penalties: [] }])),
    roundStats: new Map(cells.map(([id]) => [id, stat()])),
  };
}

function event(over: Partial<SeasonCalendarEvent>): SeasonCalendarEvent {
  return {
    id: 'e',
    event_date: '2026-01-01',
    format: 'endurance',
    round_number: null,
    subsession_id: null,
    race1_start_time: '18:00:00',
    race1_laps: null,
    race2_start_time: null,
    race2_laps: null,
    race3_start_time: null,
    race3_laps: null,
    circuits: { name: 'Track' },
    ...over,
  };
}

const visible = driver('d-visible', 'Vic Visible', false, 101);
const hidden = driver(HIDDEN_ID, 'Hidden Driver', true);

beforeEach(() => {
  mocks.getSeasons.mockResolvedValue([
    season(),
    season({ id: 's17', number: 17, name: 'ATC17', is_current: false }),
  ]);
  mocks.getScoringRulesets.mockResolvedValue([
    {
      id: 'r1',
      name: 'R',
      rules: RULES,
      is_default: true,
      can_drop_final_round: false,
      created_at: '',
      updated_at: '',
    },
  ]);
  mocks.getDriverClasses.mockResolvedValue([
    { id: 1, name: 'Alpha', sort_order: 1 },
    { id: 2, name: 'Gamma', sort_order: 2 },
    { id: 3, name: 'Delta', sort_order: 3 },
  ]);
  mocks.getStandingsExcludedRoundIds.mockResolvedValue(new Set([999]));
  mocks.driversSelect.mockResolvedValue([visible, hidden]);
  mocks.getRacePointsForSeason.mockResolvedValue([]);
  mocks.getRoundsForSeason.mockResolvedValue([
    {
      subsession_id: 11,
      season_id: 's18',
      start_time: '2026-03-01T18:00:00Z',
      track_name: 'Spa',
      season_label: null,
      round_number: 1,
      format: 'endurance',
      strength_of_field: null,
      num_drivers: null,
    },
    {
      subsession_id: 12,
      season_id: 's18',
      start_time: '2026-03-08T18:00:00Z',
      track_name: 'Monza',
      season_label: null,
      round_number: 2,
      format: 'sprint',
      strength_of_field: null,
      num_drivers: null,
    },
    {
      subsession_id: 999,
      season_id: 's18',
      start_time: '2026-03-09T18:00:00Z',
      track_name: 'Exhibition',
      season_label: null,
      round_number: null,
      format: 'endurance',
      strength_of_field: null,
      num_drivers: null,
    },
  ]);
  mocks.getSeasonCalendarEvents.mockResolvedValue([
    event({ id: 'e1', event_date: '2026-03-01', round_number: 1 }),
    event({ id: 'e2', event_date: '2026-03-08', round_number: 2, format: 'sprint' }),
    event({
      id: 'e3',
      event_date: '2026-03-15',
      round_number: 3,
      format: 'sprint',
      race2_start_time: '19:00:00',
      circuits: { name: 'Imola' },
    }),
    event({
      id: 'e4',
      event_date: '2026-03-22',
      round_number: 4,
      format: 'special',
      circuits: { name: 'Fun Run' },
    }),
    event({ id: 'e5', event_date: '2026-03-29', round_number: 5, circuits: { name: 'Suzuka' } }),
  ]);
  mocks.loadStoredSeasons.mockImplementation(async () => ({
    stats: new Map([['s18', { stored: true }]]),
    live: [],
  }));
  const rows = [
    standing(visible, [
      [11, 200],
      [12, 95],
    ]),
    standing(hidden, [[11, 190]]),
  ];
  mocks.overallStandingsFromRounds.mockReturnValue(rows);
  mocks.classStandingsFromRounds.mockReturnValue(rows);
  mocks.computeSeasonStandings.mockResolvedValue(rows);
  mocks.computeOverallSeasonStandings.mockResolvedValue(rows);
});

afterEach(() => vi.clearAllMocks());

describe('loadCalculatorSeason', () => {
  it('masks a hidden driver: "Hidden Driver" and a stand-in key, never the id (BR3.12)', async () => {
    const load = await loadCalculatorSeason(env, '18', 'overall');
    const names = load!.data.entrants.map((e) => [e.key, e.name]);
    expect(names).toEqual([
      ['d-visible', 'Vic Visible'],
      ['h4242', 'Hidden Driver'],
    ]);
    expect(JSON.stringify(load!.data)).not.toContain(HIDDEN_ID);
  });

  it('lists the run rounds, then the remaining calendar events with their race counts (FR2.6)', async () => {
    const { data } = (await loadCalculatorSeason(env, '18', 'overall'))!;
    expect(data.rounds.map((r) => [r.label, r.state, r.format, r.races])).toEqual([
      ['R1 · Spa', 'completed', 'endurance', 1],
      ['R2 · Monza', 'completed', 'sprint', 1],
      ['R3 · Imola', 'future', 'sprint', 2],
      ['R4 · Fun Run', 'special', 'special', 1],
      ['R5 · Suzuka', 'future', 'endurance', 1],
    ]);
    expect(data.entrants[0].roundPoints).toEqual([200, 95, null, null, null]);
    expect(data.rounds.map((r) => r.isFinal)).toEqual([false, false, false, false, true]);
  });

  it('gives a special round no points table and no best case', async () => {
    const { data } = (await loadCalculatorSeason(env, '18', 'overall'))!;
    const special = data.rounds[3];
    expect(special.tables).toEqual([]);
    expect(special.bestCase).toBe(0);
    expect(data.rounds[2].bestCase).toBe(200);
  });

  it('carries the drop settings and the protected final round', async () => {
    const { data } = (await loadCalculatorSeason(env, '18', 'alpha'))!;
    expect(data.dropCount).toBe(2);
    expect(data.dropsFromRounds).toBe(5);
    expect(data.canDropFinalRound).toBe(false);
    expect(mocks.classStandingsFromRounds).toHaveBeenCalledWith(expect.anything(), 1, expect.anything());
  });

  it('falls back to the live builders only when the stored round stats are incomplete', async () => {
    mocks.loadStoredSeasons.mockResolvedValueOnce({ stats: new Map(), live: [season()] });
    await loadCalculatorSeason(env, '18', 'gamma');
    expect(mocks.computeSeasonStandings).toHaveBeenCalledTimes(1);
    expect(mocks.classStandingsFromRounds).not.toHaveBeenCalled();
  });

  it('falls back to Overall for an unavailable championship and to the current season for an unknown one (BR3.13)', async () => {
    const load = await loadCalculatorSeason(env, '77', 'delta_team');
    expect(load!.championship).toBe('overall');
    expect(load!.season.number).toBe(18);
    expect(resolveChampionship('nonsense', season())).toBe('overall');
    expect(resolveChampionship('delta_team', season({ delta_team_enabled: true }))).toBe('delta_team');
    expect(
      resolveCalculatorSeason('17', [season(), season({ id: 's17', number: 17, name: 'ATC17' })])?.number,
    ).toBe(17);
    expect(availableChampionships(season({ gamma_enabled: false, delta_enabled: false }))).toEqual([
      'overall',
      'alpha',
      'alpha_team',
    ]);
  });

  it('gives each driver round its races’ points when they add up to the round, else none', async () => {
    const race = (
      driverId: string,
      subsession: number,
      raceNumber: number,
      overall: number,
      classId = 1,
    ) => ({
      subsession_id: subsession,
      race_number: raceNumber,
      driver_id: driverId,
      class_id: classId,
      overall_total: overall,
      class_total: overall + 1,
    });
    mocks.getRacePointsForSeason.mockResolvedValue([
      race('d-visible', 11, 1, 120),
      race('d-visible', 11, 2, 80),
      // Round 12 is 95 points, but these races add up to 90, so that round is left whole.
      race('d-visible', 12, 1, 90),
    ]);
    const { data } = (await loadCalculatorSeason(env, '18', 'overall'))!;
    expect(mocks.getRacePointsForSeason).toHaveBeenCalledWith(env, 's18');
    expect(data.entrants[0].racePoints).toEqual([[120, 80], null, null, null, null]);
    // No rows for the hidden driver: every round stays whole.
    expect(data.entrants[1].racePoints).toEqual([null, null, null, null, null]);
    expect(JSON.stringify(data)).not.toContain(HIDDEN_ID);

    // A class championship reads that class's class totals, which do not add up to these round points.
    const alpha = (await loadCalculatorSeason(env, '18', 'alpha'))!.data;
    expect(alpha.entrants[0].racePoints?.[0]).toBeNull();
  });

  it('still loads, with whole rounds, when the per-race read fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getRacePointsForSeason.mockRejectedValue(new Error('HTTP 500'));
    const { data } = (await loadCalculatorSeason(env, '18', 'overall'))!;
    expect(data.entrants[0].roundPoints.slice(0, 2)).toEqual([200, 95]);
    expect(data.entrants.every((e) => e.racePoints === undefined)).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('builds team entrants from the scored rows: per race the top two members count (BR3.1)', async () => {
    const row = (driverId: string, subsession: number, points: number, team = 't1'): ScoreRow =>
      ({
        subsession_id: subsession,
        race_number: 1,
        driver_id: driverId,
        team_id: team,
        class_id: 1,
        overall_total: points,
        class_total: points + 8,
      }) as ScoreRow;
    mocks.getRaceScoresForSeasonOverall.mockResolvedValue([
      row('d-visible', 11, 200),
      row(HIDDEN_ID, 11, 190),
      row('d-third', 11, 180),
      row('d-visible', 12, 95),
      row('d-visible', 999, 500),
    ]);
    mocks.getTeamsBasic.mockResolvedValue([{ id: 't1', name: 'Team One', logo_url: null }]);
    const { data } = (await loadCalculatorSeason(env, '18', 'alpha_team'))!;
    expect(data.isTeam).toBe(true);
    expect(data.dropCount).toBe(0);
    const team = data.entrants[0];
    expect(team.roundPoints.slice(0, 2)).toEqual([390, 95]);
    expect(team.members!.map((m) => m.name).sort()).toEqual([
      'Hidden Driver',
      'Unknown driver',
      'Vic Visible',
    ]);
    expect(JSON.stringify(data)).not.toContain(HIDDEN_ID);
    expect(data.rounds[2].bestCase).toBe(2 * (100 + 95) + 0);
  });
});
