/**
 * Edit Results (results-edit, US9.1): the request saveRaceIncidents sends to set_race_incidents, how its
 * errors become result codes, and how the posted `incidents[<cust_id>]` fields are read. The database rules
 * themselves are checked in supabase/checks/race-incidents-fixtures.sql. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIncidentChanges, saveRaceIncidents } from '../../src/lib/db/raceIncidents';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const raised = (code: string, details: string | null = null) =>
  respond({ code, message: 'refused', details, hint: null }, 400);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function form(fields: [string, string][]): FormData {
  const data = new FormData();
  data.set('intent', 'save-incidents');
  data.set('race_number', '1');
  for (const [key, value] of fields) data.append(key, value);
  return data;
}

describe('saveRaceIncidents', () => {
  it('posts the round, race and changes with the caller token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ changed: 2, scoring_issue: null }));
    vi.stubGlobal('fetch', fetchMock);
    const changes = [
      { cust_id: 101, incidents: 4 },
      { cust_id: 102, incidents: 0 },
    ];
    await expect(saveRaceIncidents(env, 'admin-token', 9001, 2, changes)).resolves.toEqual({
      ok: true,
      changed: 2,
      scoringIssue: null,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/set_race_incidents');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer admin-token');
    expect(init.headers.apikey).toBe('anon-key');
    expect(JSON.parse(init.body)).toEqual({ p_subsession_id: 9001, p_race_number: 2, p_changes: changes });
  });

  it('passes a scoring issue back with a successful save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ changed: 1, scoring_issue: 'No ruleset' })));
    await expect(saveRaceIncidents(env, 't', 1, 1, [{ cust_id: 1, incidents: 1 }])).resolves.toEqual({
      ok: true,
      changed: 1,
      scoringIssue: 'No ruleset',
    });
  });

  it.each([
    ['42501', null, 'not_full_admin', null],
    ['22023', '991900002', 'invalid_count', 991900002],
    ['22023', null, 'invalid_count', null],
    ['P0002', '991900004', 'not_in_race', 991900004],
    ['SC001', null, 'season_locked', null],
    ['XX000', null, 'save_failed', null],
  ])('maps %s (detail %s) to %s', async (code, details, expected, custId) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raised(code, details)));
    await expect(saveRaceIncidents(env, 't', 1, 1, [{ cust_id: 1, incidents: 1 }])).resolves.toEqual({
      ok: false,
      code: expected,
      custId,
    });
  });

  it('ignores a detail that is not a driver id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raised('22023', 'drop table')));
    const result = await saveRaceIncidents(env, 't', 1, 1, [{ cust_id: 1, incidents: 1 }]);
    expect(result).toEqual({ ok: false, code: 'invalid_count', custId: null });
  });

  it('turns a network failure or an unreadable error into save_failed without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(saveRaceIncidents(env, 't', 1, 1, [{ cust_id: 1, incidents: 1 }])).resolves.toEqual({
      ok: false,
      code: 'save_failed',
      custId: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('<html>bad gateway</html>', 502)));
    await expect(saveRaceIncidents(env, 't', 1, 1, [{ cust_id: 1, incidents: 1 }])).resolves.toEqual({
      ok: false,
      code: 'save_failed',
      custId: null,
    });
  });
});

describe('parseIncidentChanges (BR9.3)', () => {
  it('reads whole numbers from 0 to 999 keyed by cust_id, ignoring other fields', () => {
    expect(
      parseIncidentChanges(
        form([
          ['incidents[101]', '4'],
          ['incidents[102]', ' 0 '],
          ['incidents[103]', '999'],
        ]),
      ),
    ).toEqual([
      { cust_id: 101, incidents: 4 },
      { cust_id: 102, incidents: 0 },
      { cust_id: 103, incidents: 999 },
    ]);
  });

  it.each([
    ['a blank', 'incidents[101]', ''],
    ['a decimal', 'incidents[101]', '4.5'],
    ['a trailing zero decimal', 'incidents[101]', '5.0'],
    ['a negative value', 'incidents[101]', '-1'],
    ['over 999', 'incidents[101]', '1000'],
    ['an exponent', 'incidents[101]', '1e2'],
    ['a bad key', 'incidents[abc]', '4'],
    ['a zero cust_id', 'incidents[0]', '4'],
  ])('refuses the whole save for %s', (_label, key, value) => {
    expect(
      parseIncidentChanges(
        form([
          ['incidents[200]', '1'],
          [key, value],
        ]),
      ),
    ).toBeNull();
  });

  it('refuses no changes, a duplicate driver, and more than 200 rows', () => {
    expect(parseIncidentChanges(form([]))).toBeNull();
    expect(
      parseIncidentChanges(
        form([
          ['incidents[101]', '1'],
          ['incidents[101]', '2'],
        ]),
      ),
    ).toBeNull();
    const many = Array.from({ length: 201 }, (_, i) => [`incidents[${i + 1}]`, '1'] as [string, string]);
    expect(parseIncidentChanges(form(many))).toBeNull();
    expect(parseIncidentChanges(form(many.slice(0, 200)))).toHaveLength(200);
  });
});
