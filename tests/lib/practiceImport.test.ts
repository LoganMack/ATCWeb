import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Every database call the practice import makes is mocked, so no network or database is used.
vi.mock('../../src/lib/db/client', () => ({
  restGet: vi.fn(),
  restGetAll: vi.fn(),
  restGetAuthed: vi.fn(),
  restPost: vi.fn(),
  restPatch: vi.fn(),
  restDelete: vi.fn(),
}));
vi.mock('../../src/lib/db/circuits', () => ({ getCircuits: vi.fn() }));
vi.mock('../../src/lib/db/seasons', () => ({ getSeasons: vi.fn() }));
vi.mock('../../src/lib/db/events', () => ({ getEvents: vi.fn() }));
vi.mock('../../src/lib/db/drivers', () => ({ getAllDriverSeasonCarNumbers: vi.fn() }));

import { restDelete, restGet, restGetAuthed, restPatch, restPost } from '../../src/lib/db/client';
import type { SupabaseEnv } from '../../src/lib/db/client';
import { getCircuits } from '../../src/lib/db/circuits';
import { getSeasons } from '../../src/lib/db/seasons';
import { getEvents } from '../../src/lib/db/events';
import { getAllDriverSeasonCarNumbers } from '../../src/lib/db/drivers';
import { importPracticeResultsCsv, type ImportDriver } from '../../src/lib/raceResultsImport';

const env = { url: 'https://example.test', anonKey: 'test-anon-key' } as unknown as SupabaseEnv;
const token = 'test-access-token';

const HEADER = [
  'import_key',
  'circuit_name',
  'season_name',
  'event_date',
  'driver_car_number',
  'class_name',
  'laps',
  'best_lap_time',
];

// Made-up roster: car number -> driver with an iRacing customer id.
const DRIVERS: ImportDriver[] = [
  { id: 'd7', name: 'Driver Seven', car_number: 7, iracing_cust_id: 1007 },
  { id: 'd12', name: 'Driver Twelve', car_number: 12, iracing_cust_id: 1012 },
];

function csvRow(importKey: string, car: string, laps = '10', best = '1:23.4567'): string[] {
  return [importKey, 'Road America', 'ATC17', '2026-05-03', car, 'GT3', laps, best];
}

function practicePosts(): Record<string, unknown>[] {
  return vi
    .mocked(restPost)
    .mock.calls.filter(([, , path]) => path === 'curated_practice_results')
    .map(([, , , body]) => body as Record<string, unknown>);
}

let errorSpy: MockInstance<(...args: unknown[]) => void>;

function setExistingImports(rows: { import_key: string; subsession_id: number }[]) {
  vi.mocked(restGetAuthed).mockResolvedValue(rows);
}

beforeEach(() => {
  vi.mocked(getCircuits).mockResolvedValue([{ id: 'c1', name: 'Road America' }] as never);
  vi.mocked(getSeasons).mockResolvedValue([{ id: 's17', name: 'ATC17' }] as never);
  vi.mocked(getEvents).mockResolvedValue([] as never);
  vi.mocked(getAllDriverSeasonCarNumbers).mockResolvedValue([] as never);
  vi.mocked(restGet).mockImplementation(async (_env, path) => {
    if (path.startsWith('drivers?')) return DRIVERS;
    throw new Error(`unexpected restGet ${path}`);
  });
  setExistingImports([]);
  vi.mocked(restPost).mockResolvedValue(undefined as never);
  vi.mocked(restPatch).mockResolvedValue(undefined as never);
  vi.mocked(restDelete).mockResolvedValue(undefined as never);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe('importPracticeResultsCsv', () => {
  it('writes the round row and one practice row per driver for a new round', async () => {
    const outcome = await importPracticeResultsCsv(env, token, [
      HEADER,
      csvRow('k1', '7', '12', '1:23.4567'),
      csvRow('k1', '12', '9', '59.5'),
    ]);

    expect(outcome).toEqual({ imported: 2, skipped: 0 });
    const paths = vi.mocked(restPost).mock.calls.map(([, , path]) => path);
    expect(paths).toContain('curated_rounds');
    expect(paths).toContain('manual_result_imports');

    const rows = practicePosts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      cust_id: 1007,
      display_name: 'Driver Seven',
      car_class_name: 'GT3',
      laps: 12,
      best_lap_ten_thousandths: 834567,
    });
    expect(rows[1]).toMatchObject({ cust_id: 1012, laps: 9, best_lap_ten_thousandths: 595000 });
    expect(rows[0].subsession_id).toBe(rows[1].subsession_id);
    expect(rows[0].subsession_id as number).toBeLessThan(0);
    expect(restDelete).not.toHaveBeenCalled();
  });

  it('skips a repeated driver in one round before any insert, and logs it', async () => {
    const outcome = await importPracticeResultsCsv(env, token, [
      HEADER,
      csvRow('k1', '7', '12'),
      csvRow('k1', '7', '14'),
      csvRow('k1', '12', '9'),
    ]);

    expect(outcome).toEqual({ imported: 2, skipped: 1 });
    const rows = practicePosts();
    expect(rows.filter((r) => r.cust_id === 1007)).toHaveLength(1);
    expect(rows.find((r) => r.cust_id === 1007)).toMatchObject({ laps: 12 });
    expect(rows.filter((r) => r.cust_id === 1012)).toHaveLength(1);

    const messages = errorSpy.mock.calls.map((args) => String(args[0]));
    const duplicateLine = messages.find((m) => m.includes('appears twice'));
    expect(duplicateLine).toBeDefined();
    expect(duplicateLine).toContain('"k1"');
    expect(duplicateLine).toContain('car #7');
  });

  it('imports the same driver once per round when the CSV holds two rounds', async () => {
    const outcome = await importPracticeResultsCsv(env, token, [
      HEADER,
      csvRow('k1', '7'),
      csvRow('k2', '7'),
    ]);

    expect(outcome).toEqual({ imported: 2, skipped: 0 });
    const rows = practicePosts();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cust_id === 1007)).toBe(true);
    expect(rows[0].subsession_id).not.toBe(rows[1].subsession_id);
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('appears twice'))).toBe(false);
  });

  it("clears an already-imported round's practice rows before writing them again", async () => {
    setExistingImports([{ import_key: 'k1', subsession_id: -42 }]);

    const outcome = await importPracticeResultsCsv(env, token, [HEADER, csvRow('k1', '7')]);

    expect(outcome).toEqual({ imported: 1, skipped: 0 });
    expect(restDelete).toHaveBeenCalledWith(env, token, 'curated_practice_results?subsession_id=eq.-42');
    expect(restPatch).toHaveBeenCalledWith(
      env,
      token,
      'curated_rounds?subsession_id=eq.-42',
      expect.any(Object),
    );
    const rows = practicePosts();
    expect(rows).toEqual([expect.objectContaining({ subsession_id: -42, cust_id: 1007 })]);

    const practiceCallIndex = vi
      .mocked(restPost)
      .mock.calls.findIndex(([, , path]) => path === 'curated_practice_results');
    const deleteOrder = vi.mocked(restDelete).mock.invocationCallOrder[0];
    const insertOrder = vi.mocked(restPost).mock.invocationCallOrder[practiceCallIndex];
    expect(deleteOrder).toBeLessThan(insertOrder);
  });

  it("skips the round's rows and inserts nothing when clearing them fails", async () => {
    setExistingImports([{ import_key: 'k1', subsession_id: -42 }]);
    vi.mocked(restDelete).mockRejectedValue(new Error('permission denied'));

    const outcome = await importPracticeResultsCsv(env, token, [
      HEADER,
      csvRow('k1', '7'),
      csvRow('k1', '12'),
    ]);

    expect(outcome).toEqual({ imported: 0, skipped: 2 });
    expect(restPost).not.toHaveBeenCalled();
    expect(restPatch).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('Failed to clear'))).toBe(true);
  });

  it('counts a refused insert as skipped, logs it, and still imports later rows', async () => {
    let practiceInserts = 0;
    vi.mocked(restPost).mockImplementation(async (_env, _token, path) => {
      if (path === 'curated_practice_results') {
        practiceInserts++;
        if (practiceInserts === 1) throw new Error('duplicate key value violates unique constraint');
      }
      return undefined as never;
    });

    const outcome = await importPracticeResultsCsv(env, token, [
      HEADER,
      csvRow('k1', '7'),
      csvRow('k1', '12'),
    ]);

    expect(outcome).toEqual({ imported: 1, skipped: 1 });
    expect(practiceInserts).toBe(2);
    const messages = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(messages.some((m) => m.includes('Failed to import a practice row') && m.includes('car #7'))).toBe(
      true,
    );
  });
});
