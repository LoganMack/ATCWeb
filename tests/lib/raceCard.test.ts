/**
 * The round results race card (FR3.4-FR3.7; BR3.4-BR3.7): Grid Size with its fallback, the winner's on-track
 * race time, the duration format, the session's wet flag and what each view shows.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRaceCard,
  formatDuration,
  gridSize,
  raceWinner,
  wetAffectedFor,
  winnerRaceTime,
  type CardResultRow,
} from '../../src/lib/results/raceCard';
import type { EventWetFlags } from '../../src/lib/db/events';

function row(id: string, position: number | null, extra: Partial<CardResultRow> = {}): CardResultRow {
  return {
    position,
    dsq: false,
    tags: [],
    driver: { id },
    laps: 20,
    averageLapTenThousandths: 1_000_000, // 100 s
    ...extra,
  };
}

const flags: EventWetFlags = {
  id: 'event-1',
  season_id: 'season-1',
  subsession_id: null,
  practice_wet_affected: true,
  qualifying_wet_affected: false,
  race1_wet_affected: false,
  race2_wet_affected: true,
  race3_wet_affected: false,
};

describe('formatDuration (BR3.6)', () => {
  it('shows MM:SS under an hour and H:MM:SS from an hour, rounded to whole seconds', () => {
    expect(formatDuration(20 * 1_000_000)).toBe('33:20');
    expect(formatDuration(36_000_000 + 4_999)).toBe('1:00:00');
    expect(formatDuration(36_000_000 + 5_000)).toBe('1:00:01');
  });

  it('lets hours run past 24 and shows — when unknown', () => {
    expect(formatDuration(25 * 36_000_000 + 610_000)).toBe('25:01:01');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('gridSize (BR3.4)', () => {
  it("uses the round's num_drivers when set", () => {
    expect(gridSize(24, [row('a', 1)])).toBe(24);
  });

  it('otherwise counts different entrants across every race, unrostered ones included', () => {
    const rows = [row('a', 1), row('b', 2), row('a', 1), row('unrostered:77', 3)];
    expect(gridSize(null, rows)).toBe(3);
    expect(gridSize(0, rows)).toBe(3);
  });

  it('is null with no entrants', () => {
    expect(gridSize(null, [])).toBeNull();
  });
});

describe('race winner and race time (BR3.5)', () => {
  it("is P1's laps times average lap, with no time penalty added", () => {
    const rows = [row('b', 2), row('a', 1, { laps: 30, averageLapTenThousandths: 1_234_567 })];
    expect(raceWinner(rows)?.driver.id).toBe('a');
    expect(winnerRaceTime(rows)).toBe(30 * 1_234_567);
  });

  it('skips a disqualified, unclassified or unrostered P1', () => {
    expect(raceWinner([row('a', 1, { dsq: true })])).toBeNull();
    expect(raceWinner([row('a', 1, { tags: ['Unclassified'] })])).toBeNull();
    expect(raceWinner([row('unrostered:9', 1)])).toBeNull();
  });

  it('is missing when the winner has no lap data', () => {
    expect(winnerRaceTime([row('a', 1, { laps: null })])).toBeNull();
    expect(winnerRaceTime([row('a', 1, { averageLapTenThousandths: null })])).toBeNull();
  });
});

describe('wetAffectedFor (BR3.7)', () => {
  it("reads the session's own flag", () => {
    expect(wetAffectedFor({ kind: 'race', raceNumber: 2 }, flags)).toBe(true);
    expect(wetAffectedFor({ kind: 'race', raceNumber: 1 }, flags)).toBe(false);
    expect(wetAffectedFor({ kind: 'practice' }, flags)).toBe(true);
    expect(wetAffectedFor({ kind: 'qualifying' }, flags)).toBe(false);
  });

  it('is false with no event or a race the event has no flag for', () => {
    expect(wetAffectedFor({ kind: 'race', raceNumber: 1 }, null)).toBe(false);
    expect(wetAffectedFor({ kind: 'race', raceNumber: 4 }, flags)).toBe(false);
  });
});

describe('buildRaceCard (FR3.5, FR3.6)', () => {
  const rows = [row('a', 1), row('b', 2)];
  const input = {
    startTime: '2026-03-04T23:00:00Z',
    numDrivers: null,
    strengthOfField: 1850,
    roundRows: rows,
    raceRows: rows,
    wetFlags: flags,
  };

  it('shows every value in a race view', () => {
    expect(buildRaceCard({ ...input, session: { kind: 'race', raceNumber: 2 } })).toEqual({
      date: 'March 4, 2026',
      gridSize: '2',
      sof: '1850',
      raceTime: '33:20',
      wetAffected: 'Yes',
    });
  });

  it('has no Race Time in Qualifying and Practice, and — for a missing SOF', () => {
    const card = buildRaceCard({ ...input, strengthOfField: null, session: { kind: 'qualifying' } });
    expect(card.raceTime).toBeNull();
    expect(card.sof).toBe('—');
    expect(card.wetAffected).toBe('No');
  });

  it('says No and — when the round has no event and no results', () => {
    const card = buildRaceCard({
      ...input,
      roundRows: [],
      raceRows: [],
      wetFlags: null,
      session: { kind: 'race', raceNumber: 1 },
    });
    expect(card).toMatchObject({ gridSize: '—', raceTime: '—', wetAffected: 'No' });
  });
});
