/**
 * Computed track records (src/lib/results/trackRecords.ts; BR1.2-BR1.9): layout key resolution, the league
 * record and its tie order, Overall against the typed record, class records, and the news recap's "new track
 * record" marker.
 */
import { describe, expect, it } from 'vitest';
import type { Circuit, CircuitLayout } from '../../src/lib/db/circuits';
import type { RoundBestLap } from '../../src/lib/db/roundBestLaps';
import {
  buildLeagueRecords,
  classBestLapsFor,
  classTrackRecord,
  combineOverallRecord,
  createRecordKeyResolver,
  isEarlierRound,
  isNewTrackRecord,
  leagueDate,
  leagueRecord,
  resolveRecordLayoutKey,
} from '../../src/lib/results/trackRecords';
import type { DriverBasic } from '../../src/lib/results/rows';

const circuit = (id: string, name: string) => ({ id, name }) as Circuit;
const layout = (id: string, circuitId: string, name: string, record: Partial<CircuitLayout> = {}) =>
  ({
    id,
    circuit_id: circuitId,
    name,
    lap_record_seconds: null,
    lap_record_holder: null,
    lap_record_date: null,
    ...record,
  }) as CircuitLayout;

const circuits = [
  circuit('c-spa', 'Spa-Francorchamps'),
  circuit('c-monza', 'Monza'),
  circuit('c-motegi', 'Motegi'),
];
const layouts = [
  layout('l-spa', 'c-spa', 'Grand Prix'),
  layout('l-gp', 'c-monza', 'Grand Prix'),
  layout('l-junior', 'c-monza', 'Junior'),
];

function lap(overrides: Partial<RoundBestLap>): RoundBestLap {
  return {
    subsession_id: 1,
    class_id: 1,
    best_lap_ten_thousandths: 1_000_000,
    race_number: 1,
    finish_position: 1,
    cust_id: 100,
    roster_driver_id: 'd1',
    display_name: 'Racer One',
    car_name: 'Car A',
    track_name: 'Monza',
    layout: 'Grand Prix',
    start_time: '2026-03-01T23:00:00+00:00',
    ...overrides,
  };
}

const resolver = createRecordKeyResolver(circuits, layouts);
const records = (rows: RoundBestLap[]) => buildLeagueRecords(rows, resolver.resolve);

describe('resolveRecordLayoutKey (BR1.2)', () => {
  it('gives the circuit key for a circuit with no layout rows', () => {
    expect(resolveRecordLayoutKey('Motegi', null, circuits, layouts)).toEqual({
      kind: 'circuit',
      id: 'c-motegi',
    });
  });

  it('gives the only layout of a single-layout circuit, whatever the round recorded', () => {
    expect(resolveRecordLayoutKey('[Retired] Spa-Francorchamps', 'Anything', circuits, layouts)).toEqual({
      kind: 'layout',
      id: 'l-spa',
    });
  });

  it('matches the recorded layout by normalised name on a multi-layout circuit', () => {
    expect(resolveRecordLayoutKey('monza', 'junior', circuits, layouts)).toEqual({
      kind: 'layout',
      id: 'l-junior',
    });
  });

  it('gives no key for an unmatched or missing layout on a multi-layout circuit, or an unknown track', () => {
    expect(resolveRecordLayoutKey('Monza', 'Oval', circuits, layouts)).toBeNull();
    expect(resolveRecordLayoutKey('Monza', null, circuits, layouts)).toBeNull();
    expect(resolveRecordLayoutKey('Daytona', null, circuits, layouts)).toBeNull();
  });
});

describe('buildLeagueRecords (BR1.3, BR1.9)', () => {
  it('takes the fastest lap per key, and on an exact tie the earlier round', () => {
    const league = records([
      lap({ subsession_id: 2, start_time: '2026-04-01T23:00:00+00:00', roster_driver_id: 'late' }),
      lap({ subsession_id: 3, start_time: '2026-02-01T23:00:00+00:00', roster_driver_id: 'early' }),
      lap({ subsession_id: 4, best_lap_ten_thousandths: 1_000_100, roster_driver_id: 'slow' }),
    ]);
    expect(leagueRecord(league, 'layout:l-gp', 'overall')?.roster_driver_id).toBe('early');
  });

  it('breaks a same-round tie by race number, then finish position', () => {
    const league = records([
      lap({ race_number: 2, finish_position: 1, roster_driver_id: 'r2' }),
      lap({ race_number: 1, finish_position: 5, class_id: 2, roster_driver_id: 'r1p5' }),
      lap({ race_number: 1, finish_position: 3, class_id: 3, roster_driver_id: 'r1p3' }),
    ]);
    expect(leagueRecord(league, 'layout:l-gp', 'overall')?.roster_driver_id).toBe('r1p3');
  });

  it('keeps class records apart, and counts a row with no class toward Overall only', () => {
    const league = records([
      lap({ class_id: 1, best_lap_ten_thousandths: 1_010_000, roster_driver_id: 'gamma' }),
      lap({
        class_id: null,
        best_lap_ten_thousandths: 990_000,
        roster_driver_id: null,
        display_name: 'Guest',
      }),
    ]);
    expect(leagueRecord(league, 'layout:l-gp', 'overall')?.display_name).toBe('Guest');
    expect(leagueRecord(league, 'layout:l-gp', 1)?.roster_driver_id).toBe('gamma');
    expect(leagueRecord(league, 'layout:l-gp', 2)).toBeNull();
  });

  it('drops rows whose layout resolves to nothing, and empty laps', () => {
    const league = records([lap({ layout: 'Oval' }), lap({ best_lap_ten_thousandths: 0, layout: 'Junior' })]);
    expect(league.size).toBe(0);
  });
});

describe('combineOverallRecord (BR1.4, BR1.5) and class records (BR1.6)', () => {
  const typed = {
    lap_record_seconds: 100.0,
    lap_record_holder: 'Typed Holder',
    lap_record_date: '2020-05-01',
  };

  it('shows a faster league lap with the roster name, league date and car', () => {
    const record = combineOverallRecord(
      typed,
      lap({ best_lap_ten_thousandths: 999_940 }),
      new Map([['d1', 'Roster Name']]),
    );
    expect(record).toMatchObject({
      source: 'league',
      seconds: 99.994,
      formatted: '1:39.994',
      holderName: 'Roster Name',
      date: '2026-03-01',
      carName: 'Car A',
    });
  });

  it('keeps a faster typed record', () => {
    expect(combineOverallRecord(typed, lap({ best_lap_ten_thousandths: 1_000_100 }))).toMatchObject({
      source: 'typed',
      holderName: 'Typed Holder',
      date: '2020-05-01',
    });
  });

  it('gives a tie to the millisecond to the typed record', () => {
    expect(combineOverallRecord(typed, lap({ best_lap_ten_thousandths: 1_000_004 }))?.source).toBe('typed');
  });

  it('is null with neither, and falls back to whichever exists', () => {
    expect(combineOverallRecord(null, null)).toBeNull();
    expect(combineOverallRecord({ ...typed, lap_record_seconds: null }, null)).toBeNull();
    expect(combineOverallRecord(typed, null)?.source).toBe('typed');
  });

  it('shows a hidden holder as Hidden Driver and still gives the date', () => {
    const record = classTrackRecord(
      lap({ display_name: 'Hidden Driver', roster_driver_id: 'hid', cust_id: -5 }),
      new Map([['hid', 'Hidden Driver']]),
    );
    expect(record).toMatchObject({ holderName: 'Hidden Driver', date: '2026-03-01', source: 'league' });
  });

  it('dates a lap by the league time zone, not UTC', () => {
    expect(leagueDate('2026-03-02T03:00:00+00:00')).toBe('2026-03-01');
  });

  it('builds class bests for the pages from league laps only', () => {
    const driver = { id: 'd1', name: 'Racer One' } as DriverBasic;
    const bests = classBestLapsFor(
      records([lap({ class_id: 7 })]),
      'layout:l-gp',
      [7, 8],
      [driver],
      [{ car_name: 'Car A', logo_url: 'https://img/car.png' } as never],
    );
    expect([...bests.keys()]).toEqual([7]);
    expect(bests.get(7)).toMatchObject({
      seconds: 100,
      driver,
      carLogoUrl: 'https://img/car.png',
      date: '2026-03-01',
    });
  });
});

describe('isNewTrackRecord (BR1.8)', () => {
  const ownRow = lap({ subsession_id: 9 });

  it('marks a strictly faster lap and gives the previous record', () => {
    expect(
      isNewTrackRecord({
        raceBestTenThousandths: 999_000,
        roundRows: [ownRow],
        priorRows: [lap({ best_lap_ten_thousandths: 1_000_000 })],
        typed: null,
      }),
    ).toEqual({ isRecord: true, previousSeconds: 100 });
  });

  it('gives no marker for an equal time to the millisecond', () => {
    expect(
      isNewTrackRecord({
        raceBestTenThousandths: 1_000_004,
        roundRows: [ownRow],
        priorRows: [lap({ best_lap_ten_thousandths: 1_000_000 })],
        typed: null,
      }).isRecord,
    ).toBe(false);
  });

  it('marks the first lap at a layout with no previous time', () => {
    expect(
      isNewTrackRecord({
        raceBestTenThousandths: 1_200_000,
        roundRows: [ownRow],
        priorRows: [],
        typed: null,
      }),
    ).toEqual({ isRecord: true, previousSeconds: null });
  });

  it('compares against the typed record when it is faster than every earlier lap', () => {
    expect(
      isNewTrackRecord({
        raceBestTenThousandths: 990_000,
        roundRows: [ownRow],
        priorRows: [lap({ best_lap_ten_thousandths: 1_000_000 })],
        typed: { lap_record_seconds: 98.5, lap_record_holder: 'T', lap_record_date: null },
      }).isRecord,
    ).toBe(false);
  });

  it('gives no marker to a round with no rows of its own (exhibition or test)', () => {
    expect(
      isNewTrackRecord({ raceBestTenThousandths: 900_000, roundRows: [], priorRows: [], typed: null }),
    ).toEqual({ isRecord: false, previousSeconds: null });
  });

  it('orders rounds by league date, then start, then subsession', () => {
    const a = { start_time: '2026-03-02T03:00:00+00:00', subsession_id: 5 };
    const b = { start_time: '2026-03-02T12:00:00+00:00', subsession_id: 1 };
    expect(isEarlierRound(a, b)).toBe(true);
    const same = '2026-03-01T23:00:00+00:00';
    expect(
      isEarlierRound({ start_time: same, subsession_id: 1 }, { start_time: same, subsession_id: 2 }),
    ).toBe(true);
    expect(
      isEarlierRound({ start_time: same, subsession_id: 2 }, { start_time: same, subsession_id: 2 }),
    ).toBe(false);
  });
});
