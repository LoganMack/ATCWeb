/**
 * Stats > Seasons rows (FR5.4-FR5.8; BR5.1-BR5.5): which seasons and rounds count, the league-local dates, the
 * totals and averages, the class scope and the display cells.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSeasonStats,
  daysInclusive,
  formatSeasonDate,
  leagueDate,
  parseSeasonStatsScope,
  raceCpi,
  seasonStatsCells,
  type SeasonStatsInput,
  type SeasonStatsRound,
} from '../../src/lib/results/seasonStats';
import type { RaceSummaryRow, SummaryScope } from '../../src/lib/results/seasonRaceSummaries';
import type { EventWetFlags } from '../../src/lib/db/events';

const S19 = { id: 's19', number: 19, name: 'ATC19', logo_url: 'dark.png', logo_url_light: null };
const S18 = { id: 's18', number: 18, name: 'ATC18', logo_url: null, logo_url_light: null };
const EXHIBITION_SEASON = { id: 'sx', number: 900, name: 'Winter Cup', logo_url: null, logo_url_light: null };

function round(
  id: number,
  seasonId: string,
  startTime: string,
  extra: Partial<SeasonStatsRound> = {},
): SeasonStatsRound {
  return {
    subsession_id: id,
    season_id: seasonId,
    start_time: startTime,
    strength_of_field: 2000,
    num_drivers: null,
    event_id: null,
    ...extra,
  };
}

function summary(
  roundId: number,
  race: number,
  scope: SummaryScope,
  extra: Partial<RaceSummaryRow> = {},
): RaceSummaryRow {
  return {
    subsession_id: roundId,
    race_number: race,
    scope,
    winner_driver_id: `winner-${roundId}-${race}`,
    drivers: 10,
    round_drivers: 12,
    laps_total: 100,
    incidents_total: 20,
    race_time_ten_thousandths: scope === 'overall' ? 18_000_000 : null, // 30 min
    ...extra,
  };
}

function wetEvent(id: string, extra: Partial<EventWetFlags> = {}): EventWetFlags {
  return {
    id,
    season_id: 's19',
    subsession_id: null,
    practice_wet_affected: false,
    qualifying_wet_affected: false,
    race1_wet_affected: false,
    race2_wet_affected: false,
    race3_wet_affected: false,
    ...extra,
  };
}

// ATC19: rounds 1 and 2 count; round 3 is test-flagged, round 4 has no results yet (a future TBD round).
// Round 1 starts at 01:30 UTC on Mar 5, which is still Mar 4 in New York.
function input(scope: SummaryScope = 'overall'): SeasonStatsInput {
  return {
    seasons: [S18, S19, EXHIBITION_SEASON],
    rounds: [
      round(1, 's19', '2026-03-05T01:30:00Z', { event_id: 'e1', strength_of_field: 1800, num_drivers: 20 }),
      round(2, 's19', '2026-03-18T23:00:00Z', { strength_of_field: null }),
      round(3, 's19', '2026-03-25T23:00:00Z'),
      round(4, 's19', '2026-04-01T23:00:00Z'),
      round(10, 's18', '2025-09-01T23:00:00Z'),
      round(20, 'sx', '2025-12-01T23:00:00Z'),
    ],
    excludedRoundIds: new Set([3]),
    summaries: [
      summary(1, 1, 'overall', { winner_driver_id: 'ana' }),
      summary(1, 2, 'overall', { winner_driver_id: 'ana', race_time_ten_thousandths: null }),
      summary(1, 1, 'alpha', {
        winner_driver_id: 'ana',
        round_drivers: 6,
        laps_total: 60,
        incidents_total: 10,
      }),
      summary(2, 1, 'overall', { winner_driver_id: 'ben', incidents_total: 0 }),
      summary(3, 1, 'overall'),
      summary(10, 1, 'overall'),
      summary(20, 1, 'overall'),
    ],
    events: [
      wetEvent('e1', { race2_wet_affected: true }),
      wetEvent('e2', { subsession_id: 2, race1_wet_affected: true }),
    ],
    cornersByRound: new Map([
      [1, 10],
      [2, null],
    ]),
    scope,
  };
}

describe('helpers', () => {
  it('reads dates on the league calendar and counts both end days', () => {
    expect(leagueDate('2026-03-05T01:30:00Z')).toBe('2026-03-04');
    expect(daysInclusive('2026-03-04', '2026-03-18')).toBe(15);
    expect(daysInclusive('2026-03-04', '2026-03-04')).toBe(1);
  });

  it('formats dates as MMM DD, YYYY', () => {
    expect(formatSeasonDate('2026-03-04')).toBe('Mar 04, 2026');
  });

  it('falls back to Overall for an unknown class', () => {
    expect(parseSeasonStatsScope('gamma')).toBe('gamma');
    // Exact values only, matching the edge cache key.
    expect(parseSeasonStatsScope('Gamma')).toBe('overall');
    expect(parseSeasonStatsScope('combined')).toBe('overall');
    expect(parseSeasonStatsScope(null)).toBe('overall');
  });

  it('leaves a race out of CPI without corners or incidents', () => {
    expect(raceCpi(summary(1, 1, 'overall'), 10)).toBe(50);
    expect(raceCpi(summary(1, 1, 'overall'), null)).toBeNull();
    expect(raceCpi(summary(1, 1, 'overall', { incidents_total: 0 }), 10)).toBeNull();
  });
});

describe('computeSeasonStats, Overall (BR5.1-BR5.3)', () => {
  const rows = computeSeasonStats(input());

  it('lists championship seasons with counted rounds, newest first', () => {
    expect(rows.map((r) => r.seasonName)).toEqual(['ATC19', 'ATC18']);
  });

  it('counts only rounds that are not flagged and have results', () => {
    const atc19 = rows[0];
    expect(atc19.rounds).toBe(2);
    expect(atc19.races).toBe(3);
    expect(atc19.startDate).toBe('2026-03-04');
    expect(atc19.endDate).toBe('2026-03-18');
    expect(atc19.days).toBe(15);
  });

  it('sums race times, counts winners and averages SOF, grid and CPI', () => {
    const atc19 = rows[0];
    expect(atc19.totalRaceTimeTenThousandths).toBe(36_000_000);
    expect(atc19.uniqueWinners).toBe(2);
    expect(atc19.avgSof).toBe(1800); // round 2 has no SOF
    expect(atc19.avgGridSize).toBe(16); // round 1: num_drivers 20, round 2: 12 entrants
    expect(atc19.avgCpi).toBe(50); // round 2 has no corners
  });

  it('counts wet races through event_id, else the pinned event', () => {
    expect(rows[0].wetRaces).toBe(2); // round 1 race 2 (event e1), round 2 race 1 (pinned e2)
  });
});

describe('computeSeasonStats, a class (BR5.4)', () => {
  it('scopes winners, grid and CPI to the class and hides seasons where it did not run', () => {
    const rows = computeSeasonStats(input('alpha'));
    expect(rows.map((r) => r.seasonName)).toEqual(['ATC19']);
    const atc19 = rows[0];
    expect(atc19.uniqueWinners).toBe(1);
    expect(atc19.avgGridSize).toBe(6);
    expect(atc19.avgCpi).toBe(60);
    // Other columns stay as in Overall.
    expect(atc19.rounds).toBe(2);
    expect(atc19.races).toBe(3);
    expect(atc19.totalRaceTimeTenThousandths).toBe(36_000_000);
  });

  it('lists nothing when the class never ran', () => {
    expect(computeSeasonStats(input('delta'))).toEqual([]);
  });
});

describe('seasonStatsCells (BR5.5)', () => {
  it('formats each cell and marks what cannot be computed as missing', () => {
    const [atc19, atc18] = computeSeasonStats(input());
    const cells = seasonStatsCells(atc19);
    expect(cells.start).toEqual({ text: 'Mar 04, 2026', sortValue: '2026-03-04' });
    expect(cells.raceTime.text).toBe('1:00:00');
    expect(cells.grid.text).toBe('16.0');
    expect(seasonStatsCells(atc18).cpi).toEqual({ text: '—', sortValue: null });
  });
});
