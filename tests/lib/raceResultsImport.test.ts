import { describe, expect, it, vi } from 'vitest';
import {
  groupRowsByImportKey,
  makeGetter,
  mapRaceResultRow,
  normaliseHeader,
  parseLapTimeToTenThousandths,
  resolveDriverByCarNumberForSeason,
  resolveRoundIdentity,
  slugifyForImportKey,
  suggestImportKey,
  type ImportDriver,
  type RoundLookupContext,
} from '../../src/lib/raceResultsImport';

describe('normaliseHeader', () => {
  it('trims and lower-cases each cell', () => {
    expect(normaliseHeader([' Import_Key ', 'RACE_NUMBER'])).toEqual(['import_key', 'race_number']);
  });

  it('strips a leading BOM so makeGetter finds the first column', () => {
    const header = normaliseHeader(['﻿import_key', 'race_number']);
    expect(header).toEqual(['import_key', 'race_number']);
    expect(makeGetter(header)(['k1', '2'], 'import_key')).toBe('k1');
  });

  it('keeps empty cells empty', () => {
    expect(normaliseHeader(['', '  ', 'a'])).toEqual(['', '', 'a']);
  });
});

describe('makeGetter', () => {
  const get = makeGetter(['a', 'b', 'c']);

  it('returns the trimmed cell for an exact column name', () => {
    expect(get([' 1 ', '2', '3'], 'a')).toBe('1');
    expect(get(['1', '2', '3'], 'c')).toBe('3');
  });

  it('returns an empty string for a missing column', () => {
    expect(get(['1', '2', '3'], 'z')).toBe('');
  });

  it('returns an empty string when the row is shorter than the header', () => {
    expect(get(['1'], 'c')).toBe('');
  });

  it('matches case-sensitively (normalising is normaliseHeader’s job)', () => {
    expect(get(['1', '2', '3'], 'A')).toBe('');
  });
});

describe('parseLapTimeToTenThousandths', () => {
  it('parses M:SS.ssss', () => {
    // (1 * 60 + 23.4567) s * 10000
    expect(parseLapTimeToTenThousandths('1:23.4567')).toBe(834567);
  });

  it('parses seconds only', () => {
    expect(parseLapTimeToTenThousandths('59.5')).toBe(595000);
  });

  it('parses whole seconds with minutes', () => {
    expect(parseLapTimeToTenThousandths('1:05')).toBe(650000);
  });

  it('trims surrounding spaces', () => {
    expect(parseLapTimeToTenThousandths(' 59.5 ')).toBe(595000);
  });

  it('gives null for blank or unparseable values', () => {
    expect(parseLapTimeToTenThousandths('')).toBeNull();
    expect(parseLapTimeToTenThousandths('   ')).toBeNull();
    expect(parseLapTimeToTenThousandths('abc')).toBeNull();
    expect(parseLapTimeToTenThousandths('1:2:3')).toBeNull();
  });
});

describe('groupRowsByImportKey', () => {
  const header = ['import_key', 'value'];
  const get = makeGetter(header);

  it('groups rows for two rounds in one file, skipping the header row', () => {
    const rows = [header, ['r1', 'a'], ['r2', 'b'], ['r1', 'c']];
    const { groups, skipped } = groupRowsByImportKey(rows, get);
    expect([...groups.keys()]).toEqual(['r1', 'r2']);
    expect(groups.get('r1')).toEqual([
      ['r1', 'a'],
      ['r1', 'c'],
    ]);
    expect(groups.get('r2')).toEqual([['r2', 'b']]);
    expect(skipped).toBe(0);
  });

  it('counts a row with no key as skipped', () => {
    const rows = [header, ['r1', 'a'], ['', 'b']];
    const { groups, skipped } = groupRowsByImportKey(rows, get);
    expect([...groups.keys()]).toEqual(['r1']);
    expect(skipped).toBe(1);
  });

  it('ignores a fully blank row without counting it', () => {
    const rows = [header, ['r1', 'a'], ['', '  ']];
    const { groups, skipped } = groupRowsByImportKey(rows, get);
    expect(groups.get('r1')).toHaveLength(1);
    expect(skipped).toBe(0);
  });
});

describe('resolveRoundIdentity', () => {
  const header = [
    'import_key',
    'circuit_name',
    'layout',
    'season_name',
    'event_date',
    'event_time',
    'format',
    'strength_of_field',
    'exhibition',
    'test',
  ];
  const get = makeGetter(header);
  const ctx: RoundLookupContext = {
    circuits: [
      { id: 'c1', name: 'Road America' },
      { id: 'c2', name: 'Spa' },
    ],
    seasons: [{ id: 's17', name: 'ATC17' }],
    events: [
      { id: 'e1', circuit_id: 'c1', event_date: '2026-05-03' },
      { id: 'e2', circuit_id: 'c2', event_date: '2026-05-03' },
    ],
    importByKey: new Map([['old-key', -42]]),
  };

  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      import_key: 'k1',
      circuit_name: 'road america',
      layout: 'Full',
      season_name: 'atc17',
      event_date: '2026-05-03',
      event_time: '18:30',
      format: 'Sprint',
      strength_of_field: '2100',
      exhibition: '',
      test: '',
      ...overrides,
    };
    return header.map((h) => base[h] ?? '');
  }

  it('resolves a new round, matching circuit and season case-insensitively', () => {
    expect(resolveRoundIdentity('k1', get, row(), ctx, () => -1)).toEqual({
      importKey: 'k1',
      subsessionId: -1,
      alreadyImported: false,
      seasonId: 's17',
      seasonName: 'ATC17',
      circuitName: 'Road America',
      layoutName: 'Full',
      eventDate: '2026-05-03',
      startTimeIso: '2026-05-03T18:30:00.000Z',
      format: 'sprint',
      strengthOfField: 2100,
      isExhibition: false,
      isTest: false,
      eventId: 'e1',
    });
  });

  it('gives null for a malformed date', () => {
    expect(resolveRoundIdentity('k1', get, row({ event_date: '2026-1-5' }), ctx, () => -1)).toBeNull();
  });

  it('gives null for an unknown circuit', () => {
    expect(resolveRoundIdentity('k1', get, row({ circuit_name: 'Monza' }), ctx, () => -1)).toBeNull();
  });

  it('gives null for an unknown season', () => {
    expect(resolveRoundIdentity('k1', get, row({ season_name: 'ATC99' }), ctx, () => -1)).toBeNull();
  });

  it('defaults a missing event_time to 19:00:00', () => {
    const identity = resolveRoundIdentity('k1', get, row({ event_time: '' }), ctx, () => -1);
    expect(identity?.startTimeIso).toBe('2026-05-03T19:00:00.000Z');
  });

  it('keeps an event_time that already has seconds', () => {
    const identity = resolveRoundIdentity('k1', get, row({ event_time: '18:30:15' }), ctx, () => -1);
    expect(identity?.startTimeIso).toBe('2026-05-03T18:30:15.000Z');
  });

  it('pins today’s behaviour: a one-digit hour is not padded, so the timestamp is malformed', () => {
    const identity = resolveRoundIdentity('k1', get, row({ event_time: '9:00' }), ctx, () => -1);
    expect(identity?.startTimeIso).toBe('2026-05-03T9:00.000Z');
  });

  it.each(['yes', 'TRUE', '1'])('sets the exhibition flag for %s', (value) => {
    expect(resolveRoundIdentity('k1', get, row({ exhibition: value }), ctx, () => -1)?.isExhibition).toBe(
      true,
    );
  });

  it.each(['no', 'y', '0', ''])('leaves the exhibition flag unset for %j', (value) => {
    expect(resolveRoundIdentity('k1', get, row({ exhibition: value }), ctx, () => -1)?.isExhibition).toBe(
      false,
    );
  });

  it.each(['yes', 'True', '1'])('sets the test flag for %s', (value) => {
    expect(resolveRoundIdentity('k1', get, row({ test: value }), ctx, () => -1)?.isTest).toBe(true);
  });

  it.each(['no', 'false', ''])('leaves the test flag unset for %j', (value) => {
    expect(resolveRoundIdentity('k1', get, row({ test: value }), ctx, () => -1)?.isTest).toBe(false);
  });

  it('lower-cases endurance and gives a null format for anything else', () => {
    expect(resolveRoundIdentity('k1', get, row({ format: 'Endurance' }), ctx, () => -1)?.format).toBe(
      'endurance',
    );
    expect(resolveRoundIdentity('k1', get, row({ format: 'rally' }), ctx, () => -1)?.format).toBeNull();
    expect(resolveRoundIdentity('k1', get, row({ format: '' }), ctx, () => -1)?.format).toBeNull();
  });

  it('gives a null strength of field when it is blank', () => {
    expect(
      resolveRoundIdentity('k1', get, row({ strength_of_field: '' }), ctx, () => -1)?.strengthOfField,
    ).toBeNull();
  });

  it('reuses the subsession id of an already-imported key without minting a new one', () => {
    const newId = vi.fn(() => -1);
    const identity = resolveRoundIdentity('old-key', get, row({ import_key: 'old-key' }), ctx, newId);
    expect(identity?.subsessionId).toBe(-42);
    expect(identity?.alreadyImported).toBe(true);
    expect(newId).not.toHaveBeenCalled();
  });

  it('mints a new id once for a new key', () => {
    const newId = vi.fn(() => -7);
    expect(resolveRoundIdentity('k1', get, row(), ctx, newId)?.subsessionId).toBe(-7);
    expect(newId).toHaveBeenCalledTimes(1);
  });

  it('links no event when two events match the circuit and date', () => {
    const twoEvents: RoundLookupContext = {
      ...ctx,
      events: [...ctx.events, { id: 'e3', circuit_id: 'c1', event_date: '2026-05-03' }],
    };
    expect(resolveRoundIdentity('k1', get, row(), twoEvents, () => -1)?.eventId).toBeNull();
  });

  it('links no event when none matches the date', () => {
    expect(
      resolveRoundIdentity('k1', get, row({ event_date: '2026-06-01' }), ctx, () => -1)?.eventId,
    ).toBeNull();
  });
});

describe('mapRaceResultRow', () => {
  const header = [
    'import_key',
    'race_number',
    'driver_car_number',
    'finish_position',
    'starting_position',
    'incidents',
    'laps_complete',
    'laps_led',
    'interval_ten_thousandths',
    'car_name',
    'class_name',
    'average_lap_time',
    'best_lap_time',
  ];
  const get = makeGetter(header);
  const alice: ImportDriver = { id: 'd1', name: 'Alice', car_number: 7, iracing_cust_id: 1001 };
  const bob: ImportDriver = { id: 'd2', name: 'Bob', car_number: 12, iracing_cust_id: null };
  const resolveDriver = (n: number) => [alice, bob].find((d) => d.car_number === n);

  function row(overrides: Partial<Record<string, string>> = {}): string[] {
    const base: Record<string, string> = {
      import_key: 'k1',
      race_number: '2',
      driver_car_number: '7',
      finish_position: '3',
      starting_position: '5',
      incidents: '4',
      laps_complete: '30',
      laps_led: '2',
      interval_ten_thousandths: '12345',
      car_name: 'BMW M4 GT3',
      class_name: 'Alpha',
      average_lap_time: '1:40.5',
      best_lap_time: '1:39.25',
      ...overrides,
    };
    return header.map((h) => base[h] ?? '');
  }

  it('maps a full row to the insert record, fields in the posted order', () => {
    const mapped = mapRaceResultRow(row(), get, -9, resolveDriver);
    expect(mapped).toEqual({
      ok: true,
      record: {
        subsession_id: -9,
        race_number: 2,
        cust_id: 1001,
        display_name: 'Alice',
        car_name: 'BMW M4 GT3',
        car_class_name: 'Alpha',
        finish_position: 3,
        starting_position: 5,
        adjusted_position: null,
        incidents: 4,
        laps_complete: 30,
        laps_led: 2,
        interval_ten_thousandths: 12345,
        average_lap_ten_thousandths: 1005000,
        best_lap_ten_thousandths: 992500,
      },
    });
    expect(mapped.ok && Object.keys(mapped.record)).toEqual([
      'subsession_id',
      'race_number',
      'cust_id',
      'display_name',
      'car_name',
      'car_class_name',
      'finish_position',
      'starting_position',
      'adjusted_position',
      'incidents',
      'laps_complete',
      'laps_led',
      'interval_ten_thousandths',
      'average_lap_ten_thousandths',
      'best_lap_ten_thousandths',
    ]);
  });

  it('skips an unknown car number as driver', () => {
    expect(mapRaceResultRow(row({ driver_car_number: '99' }), get, -9, resolveDriver)).toEqual({
      ok: false,
      reason: 'driver',
      raceNumber: 2,
      carNumber: 99,
    });
  });

  it('skips a non-numeric car number as driver without looking the driver up', () => {
    const lookup = vi.fn(resolveDriver);
    const mapped = mapRaceResultRow(row({ driver_car_number: 'abc' }), get, -9, lookup);
    expect(mapped.ok).toBe(false);
    expect(!mapped.ok && mapped.reason).toBe('driver');
    expect(!mapped.ok && mapped.carNumber).toBeNaN();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('skips a non-numeric race number as race_number', () => {
    const mapped = mapRaceResultRow(row({ race_number: 'two' }), get, -9, resolveDriver);
    expect(!mapped.ok && mapped.reason).toBe('race_number');
    expect(!mapped.ok && mapped.raceNumber).toBeNaN();
    expect(!mapped.ok && mapped.carNumber).toBe(7);
  });

  it('skips a blank finish position as finish_position', () => {
    const mapped = mapRaceResultRow(row({ finish_position: '' }), get, -9, resolveDriver);
    expect(!mapped.ok && mapped.reason).toBe('finish_position');
  });

  it('skips a driver with no customer id as no_cust_id, carrying race and car numbers', () => {
    expect(mapRaceResultRow(row({ driver_car_number: '12' }), get, -9, resolveDriver)).toEqual({
      ok: false,
      reason: 'no_cust_id',
      raceNumber: 2,
      carNumber: 12,
    });
  });

  it('reports the first failing check when several fail', () => {
    const all = row({ driver_car_number: '99', race_number: 'x', finish_position: '' });
    expect(mapRaceResultRow(all, get, -9, resolveDriver)).toMatchObject({ ok: false, reason: 'driver' });
    const raceAndFinish = row({ race_number: 'x', finish_position: '' });
    expect(mapRaceResultRow(raceAndFinish, get, -9, resolveDriver)).toMatchObject({ reason: 'race_number' });
    const finishAndNoCust = row({ driver_car_number: '12', finish_position: '' });
    expect(mapRaceResultRow(finishAndNoCust, get, -9, resolveDriver)).toMatchObject({
      reason: 'finish_position',
    });
  });

  it('defaults a blank starting position to the finish position', () => {
    const mapped = mapRaceResultRow(row({ starting_position: '' }), get, -9, resolveDriver);
    expect(mapped.ok && mapped.record.starting_position).toBe(3);
  });

  it('defaults blank laps led and incidents to 0, and the other optional fields to null', () => {
    const mapped = mapRaceResultRow(
      row({
        laps_led: '',
        incidents: '',
        laps_complete: '',
        interval_ten_thousandths: '',
        car_name: '',
        class_name: '',
        average_lap_time: '',
        best_lap_time: '',
      }),
      get,
      -9,
      resolveDriver,
    );
    expect(mapped.ok && mapped.record).toMatchObject({
      laps_led: 0,
      incidents: 0,
      laps_complete: null,
      interval_ten_thousandths: null,
      car_name: null,
      car_class_name: null,
      average_lap_ten_thousandths: null,
      best_lap_ten_thousandths: null,
    });
  });

  it('keeps the good rows around a malformed one (two records, one skip)', () => {
    const rows = [row({ finish_position: '1' }), row({ race_number: '' }), row({ finish_position: '3' })];
    const results = rows.map((r) => mapRaceResultRow(r, get, -9, resolveDriver));
    const records = results.flatMap((r) => (r.ok ? [r.record] : []));
    expect(records.map((r) => r.finish_position)).toEqual([1, 3]);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});

describe('resolveDriverByCarNumberForSeason', () => {
  // Alice raced #9 in ATC16 (override); Bob holds #9 now. Carol's #3 is stale for ATC16.
  const alice = { id: 'a', car_number: 5 };
  const bob = { id: 'b', car_number: 9 };
  const carol = { id: 'c', car_number: 3 };
  const drivers = [alice, bob, carol];
  const seasonCarNumbers = new Map([
    ['a:s16', 9],
    ['c:s16', 4],
  ]);

  it('resolves the same number to different drivers per season', () => {
    expect(resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, 's16', 9)).toBe(alice);
    expect(resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, 's17', 9)).toBe(bob);
  });

  it('does not fall back to the current number of a driver with an override for that season', () => {
    expect(resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, 's16', 3)).toBeUndefined();
    expect(resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, 's16', 4)).toBe(carol);
  });

  it('gives undefined for an unknown number', () => {
    expect(resolveDriverByCarNumberForSeason(drivers, seasonCarNumbers, 's17', 42)).toBeUndefined();
  });
});

describe('slugifyForImportKey and suggestImportKey', () => {
  it('removes spaces and punctuation and lower-cases', () => {
    expect(slugifyForImportKey('Road America')).toBe('roadamerica');
    expect(slugifyForImportKey('Spa-Francorchamps 2024')).toBe('spafrancorchamps2024');
  });

  it('drops accented letters rather than transliterating them', () => {
    expect(slugifyForImportKey('Nürburgring')).toBe('nrburgring');
  });

  it('prefixes the key by event category', () => {
    const base = { eventDate: '2026-08-09', circuitName: 'Watkins Glen' };
    expect(suggestImportKey({ ...base, category: 'exhibition' })).toBe('exh-2026-08-09-watkinsglen');
    expect(suggestImportKey({ ...base, category: 'test' })).toBe('test-2026-08-09-watkinsglen');
    expect(suggestImportKey({ ...base, category: 'championship' })).toBe('evt-2026-08-09-watkinsglen');
  });
});
