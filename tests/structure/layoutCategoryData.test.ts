/**
 * The layout-category data fix (FR5.10.4, US5.9, BR10.3, BR10.7 to BR10.13, NFR10.1 to NFR10.10). The fix is
 * applied by hand after merge and never runs in CI, so these text checks are what keep it in step with the
 * owner-approved list (the committed fixture) and keep its one statement narrow. No database, no network.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FIXES = import.meta.glob('/supabase/data-fixes/*_set_layout_categories.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// Keys only: no migration is loaded as text.
const MIGRATION_HITS = import.meta.glob('/supabase/migrations/**/*set_layout_categories*');
const FIXTURE = readFileSync('tests/fixtures/layout-categories/live-layouts.tsv', 'utf8')
  .split('\r')
  .join('');

const APPROVED_COUNT = 95;
const KEYS = ['oval', 'roval', 'road_long', 'road_short', 'street'];
const FIXTURE_HEADER = 'id\tcircuit\tlayout\tlength_km\tcategory';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The low-confidence table in functional-design/functional-spec.md.
const LOW_CONFIDENCE_IDS = [
  '0ef8bc71-750c-4f19-9036-1e4929c29b19',
  'bc4d6aef-0b57-4357-b5ef-4d5cab298d03',
  'daac346d-8f56-4209-8b94-216f583cad7f',
  '9b999717-6b77-4e54-b8ea-e62a2c524b5c',
  '1bb3183a-d7c3-45d5-873f-e42f9417b842',
  '575e96a0-4676-4fb2-b062-8d94c3dfaeaf',
  '9c3c3695-8bca-4f91-8228-a949a26832f2',
  'f0db8a78-5b0d-4457-9c10-5bcab98f45a8',
  'a1a5a985-4701-4065-b0ef-303275e9ccde',
  '8ecd4b74-7582-445f-9108-c005a946435e',
  'c807f8f1-244d-4d74-a232-6324a9aef1c9',
  '43728ebe-5c85-401f-9698-367aa163e811',
  'dd591b99-ee3b-41ae-91a6-2cac134fdb3e',
  '09f8df1e-be1a-49d2-a4f3-3585b90ab790',
  '5963dccc-9b3b-44d7-aa0d-b368d5c7e635',
  '3b8a05cc-b4d4-4539-b7c8-e902f5a9da91',
  'f39694d0-0a4a-4a81-a877-3d8b725a31e6',
  'a94d985f-e98d-4e1d-9bfa-8831e31b8326',
  '388166c4-d094-43e0-84f4-133153ec131a',
  '304e0477-7ce1-498f-b061-c8743506207c',
  '1ba81aca-2d9b-40cb-86dc-499c4cf6ed00',
  '61de31ee-c6fa-4e8d-83cc-a69ffcd393f0',
  '5b0f6f5b-79ae-4b3f-b9f6-791f65448fe4',
  'a432065d-4270-4921-9bdd-231eb035b009',
];

const fixKeys = Object.keys(FIXES);
const FILE = (fixKeys.length === 1 ? FIXES[fixKeys[0]] : '').split('\r').join('');
const lines = FILE.split('\n');
const headerEnd = lines.findIndex((line) => !line.startsWith('--'));
const headerLines = headerEnd === -1 ? lines : lines.slice(0, headerEnd);
const headerText = headerLines
  .map((line) => line.replace(/^--/, ''))
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const body = (headerEnd === -1 ? [] : lines.slice(headerEnd)).join('\n').replace(/--.*$/gm, '');
const flat = body
  .replace(/\s+/g, ' ')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')')
  .replace(/\s*,\s*/g, ', ')
  .trim();
const STATEMENT =
  /^update public\.circuit_layouts (as )?cl set category = v\.category from \(values (.+)\) as v\(id, category\) where cl\.id = v\.id and cl\.category is null;$/;
const ROW = /\('([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'::uuid, '([a-z_]+)'\)/g;
const values = flat.match(STATEMENT)?.[2] ?? '';
const sqlRows = [...values.matchAll(ROW)].map((m) => ({ id: m[1], category: m[2] }));

const fixtureLines = FIXTURE.split('\n');
while (fixtureLines.length > 0 && fixtureLines[fixtureLines.length - 1] === '') fixtureLines.pop();
const fixtureRows = fixtureLines.slice(1).map((line) => {
  const fields = line.split('\t');
  const [id, circuit, layout, lengthKm, category] = fields;
  return { id, circuit, layout, lengthKm, category, fields: fields.length };
});
const fixtureCategory = new Map(fixtureRows.map((r) => [r.id, r.category]));
const countBy = (key: string) => fixtureRows.filter((r) => r.category === key).length;

/** A `YYYYMMDD` or `YYYY-MM-DD` that names a real calendar day. */
const isRealDate = (y: string, m: string, d: string) => {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
};

describe('layout-category data fix', () => {
  it('exactly one dated data fix exists and none under supabase/migrations', () => {
    expect(fixKeys).toHaveLength(1);
    const name = fixKeys[0].split('/').pop() ?? '';
    const match = name.match(/^(\d{4})(\d{2})(\d{2})_set_layout_categories\.sql$/);
    expect(match).not.toBeNull();
    expect(isRealDate(match![1], match![2], match![3])).toBe(true);
    expect(Object.keys(MIGRATION_HITS)).toEqual([]);
  });

  it('the fixture has 95 unique rows with valid categories', () => {
    expect(fixtureLines[0]).toBe(FIXTURE_HEADER);
    expect(fixtureRows).toHaveLength(APPROVED_COUNT);
    for (const row of fixtureRows) {
      expect(row.fields, row.id).toBe(5);
      expect(row.id).toMatch(UUID);
      expect(KEYS).toContain(row.category);
    }
    expect(new Set(fixtureRows.map((r) => r.id)).size).toBe(APPROVED_COUNT);
  });

  it('the body is one update of category only, joined by id, guarded by category is null', () => {
    expect(flat).toMatch(STATEMENT);
    expect(values.replace(ROW, '').replace(/, /g, '')).toBe('');
  });

  it('the body holds exactly one statement', () => {
    const trimmed = body.trim();
    expect(trimmed.split(';')).toHaveLength(2);
    expect(trimmed.endsWith(';')).toBe(true);
  });

  it('the body uses no other statement or keyword', () => {
    const banned = [
      'insert',
      'delete',
      'alter',
      'drop',
      'truncate',
      'create',
      'grant',
      'revoke',
      'select',
      'copy',
      'begin',
      'commit',
      'execute',
      'do',
    ];
    for (const word of banned) expect(body, word).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    expect(body).not.toContain('/*');
    expect(body.match(/\bset\b/gi) ?? []).toHaveLength(1);
  });

  it('every SQL row matches the fixture (id, category) pair', () => {
    const ids = sqlRows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(fixtureCategory.has(id), id).toBe(true);
    for (const row of fixtureRows) expect(ids, row.id).toContain(row.id);
    for (const row of sqlRows) expect(row.category, row.id).toBe(fixtureCategory.get(row.id));
    expect(ids).toEqual(fixtureRows.map((r) => r.id));
  });

  it('the fixture agrees with the 4.023 km rule', () => {
    for (const row of fixtureRows) {
      const km = Number(row.lengthKm);
      if (row.category === 'road_long') expect(km, row.id).toBeGreaterThan(4.023);
      if (row.category === 'road_short') expect(km, row.id).toBeLessThanOrEqual(4.023);
    }
  });

  it('the header states UPDATE count and per-category counts from the fixture', () => {
    expect(headerText).toContain(`UPDATE ${APPROVED_COUNT}`);
    for (const key of KEYS) {
      const count = countBy(key);
      if (count > 0) expect(headerText).toMatch(new RegExp(`\\b${key} ${count}\\b`));
    }
  });

  it('the header spot check lists 5 ids that match the fixture and cover every category plus a low-confidence row', () => {
    const spot = headerLines
      .map((line) => line.match(/^--\s+([0-9a-f-]{36})\s+([a-z_]+)\s*$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ id: m[1], category: m[2] }));
    expect(spot).toHaveLength(5);
    for (const pair of spot) expect(pair.category, pair.id).toBe(fixtureCategory.get(pair.id));
    const present = KEYS.filter((key) => countBy(key) > 0);
    expect(new Set(spot.map((p) => p.category))).toEqual(new Set(present));
    expect(spot.some((p) => LOW_CONFIDENCE_IDS.includes(p.id))).toBe(true);
  });

  it('the header holds the undo note', () => {
    expect(headerText).toMatch(/undo/i);
    expect(headerText).toContain('set category = null');
    expect(headerText).toContain('cl.category = v.category');
    expect(headerText).toContain('no down script');
  });

  it('the header names the migration, the Deploy run and by-hand apply', () => {
    expect(headerText).toContain('20261123120000');
    expect(headerText).toContain('Deploy');
    expect(headerText).toContain('by hand');
    const approved = headerText.match(/approved on (\d{4})-(\d{2})-(\d{2})/);
    expect(approved).not.toBeNull();
    expect(isRealDate(approved![1], approved![2], approved![3])).toBe(true);
  });

  it('no part of the file looks like a secret', () => {
    expect(FILE).not.toBe('');
    for (const pattern of [
      /eyJ/i,
      /service_role/i,
      /\bsk_/i,
      /postgres:\/\//i,
      /postgresql:\/\//i,
      /password/i,
    ]) {
      expect(FILE).not.toMatch(pattern);
    }
  });
});
