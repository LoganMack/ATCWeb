/**
 * Rulebook data access (src/lib/db/rulebook.ts): the public read asks for the newest row only (NFR5), saves
 * map the database's refusal codes to typed results (FR4.3, FR4.5), invalid input never reaches the database
 * (FR4.3), and restore saves the old text again as a new version (FR4.4). PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestRulebook,
  listRulebookVersions,
  parseRulebookVersionId,
  restoreRulebookVersion,
  rulebookErrorCode,
  saveRulebookVersion,
  shapeRulebookInput,
} from '../../src/lib/db/rulebook';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const TOKEN = 'admin-token';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
/** A PostgREST error body for a function that raised '<message>' with errcode P0001. */
const raised = (message: string) => respond({ code: 'P0001', message, details: null, hint: null }, 400);

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getLatestRulebook (NFR5)', () => {
  it('asks for one row, newest id first, with only the page columns', async () => {
    const row = { id: 7, version_label: '18.3', body_md: '## 1. Rules', saved_at: '2026-10-25T00:00:00Z' };
    const fetchMock = stubFetch(respond([row]));
    expect(await getLatestRulebook(env)).toEqual(row);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/rest/v1/rulebook_versions');
    expect(url.searchParams.get('order')).toBe('id.desc');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('select')).toBe('id,version_label,body_md,saved_at');
  });

  it('returns null before anything is published', async () => {
    stubFetch(respond([]));
    expect(await getLatestRulebook(env)).toBeNull();
  });

  it('surfaces a database error to the caller', async () => {
    stubFetch(respond({ message: 'boom' }, 500));
    await expect(getLatestRulebook(env)).rejects.toThrow(/500/);
  });
});

describe('listRulebookVersions', () => {
  it('reads labels, times and saver names without bodies, newest first', async () => {
    const fetchMock = stubFetch(
      respond([
        { id: 9, version_label: '18.4', saved_at: 't2', saver: { display_name: 'Logan' } },
        { id: 8, version_label: '18.3', saved_at: 't1', saver: null },
      ]),
    );
    expect(await listRulebookVersions(env, TOKEN)).toEqual([
      { id: 9, version_label: '18.4', saved_at: 't2', saved_by_name: 'Logan' },
      { id: 8, version_label: '18.3', saved_at: 't1', saved_by_name: null },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('body_md');
    expect(url).toContain('order=id.desc');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('saveRulebookVersion (FR4.3, FR4.5)', () => {
  it('calls the database function with the trimmed label, LF line endings and the expected id', async () => {
    const fetchMock = stubFetch(respond(12));
    const result = await saveRulebookVersion(env, TOKEN, {
      label: ' 18.4 ',
      body: '## A\r\n\r\nText',
      expectedLatestId: 11,
    });
    expect(result).toEqual({ ok: true, id: 12 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/save_rulebook_version');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      p_version_label: '18.4',
      p_body_md: '## A\n\nText',
      p_expected_latest_id: 11,
    });
  });

  it('maps a stale-version refusal to STALE_VERSION', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(raised('STALE_VERSION: Someone saved the rulebook after you opened it'));
    const result = await saveRulebookVersion(env, TOKEN, { label: '18.4', body: 'x', expectedLatestId: 3 });
    expect(result).toMatchObject({ ok: false, code: 'STALE_VERSION' });
    expect(result.ok ? '' : result.message).toMatch(/Someone else saved/);
  });

  it('maps NOT_ADMIN, both INVALID fields and anything else', () => {
    expect(rulebookErrorCode({ message: 'NOT_ADMIN: Only admins can save the rulebook' })).toBe('NOT_ADMIN');
    expect(rulebookErrorCode({ message: 'INVALID: version_label: Enter a version label' })).toBe(
      'INVALID_LABEL',
    );
    expect(rulebookErrorCode({ message: 'INVALID: body_md: Enter the rulebook text' })).toBe('INVALID_BODY');
    expect(rulebookErrorCode({ message: 'permission denied for function save_rulebook_version' })).toBe(
      'UNKNOWN',
    );
    expect(rulebookErrorCode(null)).toBe('UNKNOWN');
  });

  it('refuses an empty label or body before calling the database', async () => {
    const fetchMock = stubFetch();
    expect(
      await saveRulebookVersion(env, TOKEN, { label: '   ', body: 'x', expectedLatestId: 1 }),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_LABEL',
    });
    expect(
      await saveRulebookVersion(env, TOKEN, { label: '18.4', body: ' \n\t', expectedLatestId: 1 }),
    ).toMatchObject({ ok: false, code: 'INVALID_BODY' });
    expect(
      await saveRulebookVersion(env, TOKEN, { label: 'x'.repeat(41), body: 'x', expectedLatestId: 1 }),
    ).toMatchObject({ ok: false, code: 'INVALID_LABEL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a network failure as UNKNOWN instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(
      await saveRulebookVersion(env, TOKEN, { label: '18.4', body: 'x', expectedLatestId: null }),
    ).toMatchObject({ ok: false, code: 'UNKNOWN' });
  });
});

describe('restoreRulebookVersion (FR4.4)', () => {
  it('saves the old label and text as a new version against the current latest id', async () => {
    const fetchMock = stubFetch(
      respond([{ id: 4, version_label: '18.2', body_md: 'Old text', saved_at: 't' }]),
      respond(15),
    );
    expect(await restoreRulebookVersion(env, TOKEN, 4, 14)).toEqual({ ok: true, id: 15 });
    expect(fetchMock.mock.calls[0][0]).toContain('id=eq.4');
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      p_version_label: '18.2',
      p_body_md: 'Old text',
      p_expected_latest_id: 14,
    });
  });

  it('reports a version that is gone as NOT_FOUND', async () => {
    stubFetch(respond([]));
    expect(await restoreRulebookVersion(env, TOKEN, 4, 14)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('input shaping', () => {
  it('parses only positive integer ids', () => {
    expect(parseRulebookVersionId('12')).toBe(12);
    expect(parseRulebookVersionId(' 3 ')).toBe(3);
    for (const bad of ['', '0', '-1', '1.5', 'abc', null, undefined, '1;drop']) {
      expect(parseRulebookVersionId(bad), String(bad)).toBeNull();
    }
  });

  it('keeps a body with leading spaces as written, apart from line endings', () => {
    expect(shapeRulebookInput('18.4', '    indented\r\nline')).toEqual({
      ok: true,
      label: '18.4',
      body: '    indented\nline',
    });
  });
});
