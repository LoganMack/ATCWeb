/**
 * Liveries on the own profile (profile-liveries FR5): storage paths, input checks (FR5.10), database error
 * mapping (FR5.3, FR5.4, FR5.7), grouping by season (FR5.8), the tab's load with one batch thumbnail signing
 * (NFR3), and every intent's requests and refusals with Storage and PostgREST stubbed through fetch (NFR4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanLiveryFileName,
  defaultLiverySeasonId,
  groupLiveries,
  handleLiveryProfileIntent,
  liveryPath,
  liveryStatusMessage,
  loadMyLiveries,
  mapLiveryDbError,
  parseLiveryImageType,
  parseLiverySize,
  type LiveryRow,
  type LiverySeason,
} from '../../src/lib/liveries';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const USER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const LIVERY_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const SEASON_18 = 'cccccccc-1111-4222-8333-444444444418';
const SEASON_17 = 'cccccccc-1111-4222-8333-444444444417';
const TOKEN = 'user-token';
const owner = { accessToken: TOKEN, userId: USER_ID };

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('paths and input checks (FR5.10)', () => {
  it('builds the owner-folder paths the storage policies allow', () => {
    expect(liveryPath(USER_ID, LIVERY_ID, 'base')).toBe(`${USER_ID}/${LIVERY_ID}/base.tga.gz`);
    expect(liveryPath(USER_ID, LIVERY_ID, 'spec')).toBe(`${USER_ID}/${LIVERY_ID}/spec.mip.gz`);
    expect(liveryPath(USER_ID, LIVERY_ID, 'thumb')).toBe(`${USER_ID}/${LIVERY_ID}/thumb`);
  });

  it('keeps a file name ending in the right extension and drops folders and control characters', () => {
    expect(cleanLiveryFileName('C:\\paints\\car_123.TGA', '.tga')).toBe('car_123.TGA');
    expect(cleanLiveryFileName('spec\u0007.mip', '.mip')).toBe('spec.mip');
    expect(cleanLiveryFileName('car.png', '.tga')).toBeNull();
    expect(cleanLiveryFileName('car.tga', '.mip')).toBeNull();
    expect(cleanLiveryFileName('.tga', '.tga')).toBeNull();
    expect(cleanLiveryFileName(`${'a'.repeat(197)}.tga`, '.tga')).toBeNull();
  });

  it('accepts sizes from 1 byte to 20 MB only', () => {
    expect(parseLiverySize('1')).toBe(1);
    expect(parseLiverySize(String(20 * 1024 * 1024))).toBe(20 * 1024 * 1024);
    expect(parseLiverySize(String(20 * 1024 * 1024 + 1))).toBeNull();
    expect(parseLiverySize('0')).toBeNull();
    expect(parseLiverySize('12.5')).toBeNull();
  });

  it('accepts WebP and JPEG images only', () => {
    expect(parseLiveryImageType('image/webp')).toBe('image/webp');
    expect(parseLiveryImageType('image/png')).toBeNull();
  });
});

describe('database errors (FR5.3, FR5.4, FR5.7)', () => {
  it('reads the raised codes, RLS refusals, unique clashes and checks', () => {
    expect(
      mapLiveryDbError({ code: 'P0001', message: 'LIMIT_REACHED: a season holds at most 3 liveries' }),
    ).toBe('LIMIT_REACHED');
    expect(mapLiveryDbError(JSON.stringify({ message: 'FILES_MISSING: upload the spec map first' }))).toBe(
      'FILES_MISSING',
    );
    expect(mapLiveryDbError({ code: '42501', message: 'new row violates row-level security policy' })).toBe(
      'NOT_LINKED',
    );
    expect(mapLiveryDbError({ code: '23505', message: 'duplicate key' })).toBe('CONFLICT');
    expect(mapLiveryDbError({ code: '23514', message: 'check' })).toBe('INVALID');
    expect(mapLiveryDbError('gateway timeout')).toBe('UNKNOWN');
  });

  it('turns a redirect status code back into its message', () => {
    expect(liveryStatusMessage('error_LIMIT_REACHED')?.message).toMatch(/at most 3 liveries/);
    expect(liveryStatusMessage('done')).toEqual({ ok: true, message: 'Saved.' });
    expect(liveryStatusMessage('error_SOMETHING')).toBeNull();
    expect(liveryStatusMessage(null)).toBeNull();
  });
});

const seasons: LiverySeason[] = [
  { id: SEASON_17, number: 17, label: 'ATC 17', isCurrent: false },
  { id: SEASON_18, number: 18, label: 'ATC 18', isCurrent: true },
];
const row = (over: Partial<LiveryRow>): LiveryRow => ({
  id: LIVERY_ID,
  seasonId: SEASON_18,
  tgaName: 'car.tga',
  tgaSize: 100,
  mipName: null,
  mipSize: null,
  isActive: false,
  createdAt: '2026-10-20T00:00:00Z',
  thumbUrl: null,
  ...over,
});

describe('grouping (FR5.2, FR5.8)', () => {
  it('lists seasons newest first, the active livery first within its season, then newest', () => {
    const groups = groupLiveries(
      [
        row({ id: 'old', seasonId: SEASON_17 }),
        row({ id: 'a', createdAt: '2026-10-21T00:00:00Z' }),
        row({ id: 'active', isActive: true, createdAt: '2026-10-01T00:00:00Z' }),
        row({ id: 'b', createdAt: '2026-10-22T00:00:00Z' }),
      ],
      seasons,
    );
    expect(groups.map((g) => g.season.label)).toEqual(['ATC 18', 'ATC 17']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['active', 'b', 'a']);
  });

  it('leaves out empty seasons and keeps rows of an unknown season at the end', () => {
    const groups = groupLiveries([row({ seasonId: 'gone' })], seasons);
    expect(groups.map((g) => g.season.label)).toEqual(['Unknown season']);
  });

  it('preselects the current season, else the newest', () => {
    expect(defaultLiverySeasonId(seasons)).toBe(SEASON_18);
    expect(defaultLiverySeasonId(seasons.map((s) => ({ ...s, isCurrent: false })))).toBe(SEASON_17);
    expect(defaultLiverySeasonId([])).toBeNull();
  });
});

describe('loadMyLiveries (FR5.5, FR5.8, NFR3)', () => {
  const dbRow = {
    id: LIVERY_ID,
    season_id: SEASON_18,
    tga_name: 'car.tga',
    tga_size: 100,
    mip_name: null,
    mip_size: null,
    is_active: true,
    created_at: '2026-10-20T00:00:00Z',
  };

  it('reads the rows as the owner and signs every thumbnail in one batch request', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/rest/v1/seasons')) {
        return respond([
          { id: SEASON_18, number: 18, name: '', is_current: true },
          { id: SEASON_17, number: 17, name: 'ATC 17', is_current: false },
        ]);
      }
      if (call.url.includes('/rest/v1/liveries')) return respond([dbRow]);
      return respond([
        { path: `${USER_ID}/${LIVERY_ID}/thumb`, signedURL: '/object/sign/liveries/x?token=t' },
      ]);
    });
    const data = await loadMyLiveries(env, owner);
    expect(data?.groups[0].season.label).toBe('Season 18');
    expect(data?.groups[0].rows[0].thumbUrl).toBe(`${env.url}/storage/v1/object/sign/liveries/x?token=t`);
    expect(data?.defaultSeasonId).toBe(SEASON_18);
    const sign = calls.filter((c) => c.url.includes('/storage/'));
    expect(sign).toHaveLength(1);
    expect(sign[0].url).toBe(`${env.url}/storage/v1/object/sign/liveries`);
    expect(sign[0].body).toEqual({ expiresIn: 3600, paths: [`${USER_ID}/${LIVERY_ID}/thumb`] });
    const list = calls.find((c) => c.url.includes('/rest/v1/liveries'));
    expect(list?.url).toContain(`profile_id=eq.${USER_ID}`);
    expect(list?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('answers null when the rows cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((call) => (call.url.includes('/rest/v1/seasons') ? respond([]) : respond({}, 500)));
    expect(await loadMyLiveries(env, owner)).toBeNull();
  });
});

describe('the upload intents (FR5.2-FR5.4, NFR4)', () => {
  const uploadFields = {
    season_id: SEASON_18,
    tga_name: 'car_1.tga',
    tga_size: '1000',
    thumb_type: 'image/webp',
    preview_type: 'image/webp',
  };

  it('prepare-livery signs three upload links in the owner folder for a new id', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/rest/v1/liveries')) return respond([]);
      const path = call.url.split('/upload/sign/liveries/')[1];
      return respond({ url: `/object/upload/sign/liveries/${path}?token=t` });
    });
    const result = await handleLiveryProfileIntent('prepare-livery', env, owner, form(uploadFields));
    expect(result.ok).toBe(true);
    const id = result.data?.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const signs = calls.filter((c) => c.url.includes('/upload/sign/'));
    expect(signs.map((c) => c.url.split('/liveries/')[1])).toEqual([
      `${USER_ID}/${id}/base.tga.gz`,
      `${USER_ID}/${id}/thumb`,
      `${USER_ID}/${id}/preview`,
    ]);
    expect(
      signs.every((c) => c.method === 'POST' && c.headers.get('Authorization') === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(signs.every((c) => c.headers.get('x-upsert') === null)).toBe(true);
    expect((result.data?.uploads as Record<string, string>).base).toBe(
      `${env.url}/storage/v1/object/upload/sign/liveries/${USER_ID}/${id}/base.tga.gz?token=t`,
    );
  });

  it('prepare-livery refuses a fourth livery in a season before anything is uploaded', async () => {
    const calls = stubFetch(() => respond([{ id: '1' }, { id: '2' }, { id: '3' }]));
    const result = await handleLiveryProfileIntent('prepare-livery', env, owner, form(uploadFields));
    expect(result).toMatchObject({ ok: false, status: 409, code: 'error_LIMIT_REACHED' });
    expect(calls.some((c) => c.url.includes('/storage/'))).toBe(false);
  });

  it('prepare-livery refuses a wrong extension or an oversized file without a request', async () => {
    const calls = stubFetch(() => respond([]));
    const wrong = await handleLiveryProfileIntent(
      'prepare-livery',
      env,
      owner,
      form({ ...uploadFields, tga_name: 'car.png' }),
    );
    expect(wrong).toMatchObject({ ok: false, status: 400, message: 'Pick a .tga file as the base livery.' });
    const big = await handleLiveryProfileIntent(
      'prepare-livery',
      env,
      owner,
      form({ ...uploadFields, tga_size: String(21 * 1024 * 1024) }),
    );
    expect(big.message).toBe('Files can be at most 20 MB.');
    expect(calls).toHaveLength(0);
  });

  it('create-livery posts only the granted columns', async () => {
    const calls = stubFetch(() => respond([{ id: LIVERY_ID }], 201));
    const result = await handleLiveryProfileIntent(
      'create-livery',
      env,
      owner,
      form({ ...uploadFields, livery_id: LIVERY_ID }),
    );
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${env.url}/rest/v1/liveries` });
    expect(calls[0].body).toEqual({
      id: LIVERY_ID,
      season_id: SEASON_18,
      tga_name: 'car_1.tga',
      tga_size: 1000,
    });
  });

  it('create-livery maps a database refusal and removes the files it left behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubFetch((call) =>
      call.url.includes('/rest/v1/')
        ? respond({ code: 'P0001', message: 'LIMIT_REACHED: a season holds at most 3 liveries' }, 400)
        : respond([]),
    );
    const result = await handleLiveryProfileIntent(
      'create-livery',
      env,
      owner,
      form({ ...uploadFields, livery_id: LIVERY_ID }),
    );
    expect(result.code).toBe('error_LIMIT_REACHED');
    const removal = calls.find((c) => c.method === 'DELETE');
    expect(removal?.url).toBe(`${env.url}/storage/v1/object/liveries`);
    expect(removal?.body).toEqual({
      prefixes: [
        `${USER_ID}/${LIVERY_ID}/base.tga.gz`,
        `${USER_ID}/${LIVERY_ID}/thumb`,
        `${USER_ID}/${LIVERY_ID}/preview`,
      ],
    });
  });

  it('prepare-livery-mip signs an upserting link for the spec map of an own livery', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/rest/v1/')
        ? respond([{ id: LIVERY_ID, tga_name: 'car.tga' }])
        : respond({ url: '/object/upload/sign/liveries/p?token=t' }),
    );
    const result = await handleLiveryProfileIntent(
      'prepare-livery-mip',
      env,
      owner,
      form({ livery_id: LIVERY_ID, mip_name: 'car_spec.mip', mip_size: '500' }),
    );
    expect(result).toMatchObject({ ok: true, data: { upsert: true } });
    const sign = calls.find((c) => c.url.includes('/upload/sign/'));
    expect(sign?.url).toContain(`${USER_ID}/${LIVERY_ID}/spec.mip.gz`);
    expect(sign?.headers.get('x-upsert')).toBe('true');
  });

  it('a spec map is refused when the livery is not the owner’s (no .tga row)', async () => {
    stubFetch(() => respond([]));
    const result = await handleLiveryProfileIntent(
      'prepare-livery-mip',
      env,
      owner,
      form({ livery_id: LIVERY_ID, mip_name: 'car_spec.mip', mip_size: '500' }),
    );
    expect(result).toMatchObject({ ok: false, status: 404, code: 'error_NOT_FOUND' });
  });

  it('set-livery-mip reports a missing spec file as FILES_MISSING', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubFetch(() =>
      respond({ code: 'P0001', message: 'FILES_MISSING: upload the spec map first' }, 400),
    );
    const result = await handleLiveryProfileIntent(
      'set-livery-mip',
      env,
      owner,
      form({ livery_id: LIVERY_ID, mip_name: 'car_spec.mip', mip_size: '500' }),
    );
    expect(result.code).toBe('error_FILES_MISSING');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ mip_name: 'car_spec.mip', mip_size: 500 });
  });
});

describe('the row intents (FR5.6, FR5.7, FR5.11)', () => {
  const ownRow = [{ id: LIVERY_ID, tga_name: 'car.tga', mip_name: 'spec.mip', season_id: SEASON_18 }];

  it('livery-files signs 60-second links for the .tga and the .mip with their original names', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('/rest/v1/')
        ? respond(ownRow)
        : respond({ signedURL: '/object/sign/liveries/f?token=t' }),
    );
    const result = await handleLiveryProfileIntent(
      'livery-files',
      env,
      owner,
      form({ livery_id: LIVERY_ID }),
    );
    expect(result.ok).toBe(true);
    expect((result.data?.files as { name: string }[]).map((f) => f.name)).toEqual(['car.tga', 'spec.mip']);
    const signs = calls.filter((c) => c.url.includes('/object/sign/'));
    expect(signs.map((c) => c.url.split('/liveries/')[1])).toEqual([
      `${USER_ID}/${LIVERY_ID}/base.tga.gz`,
      `${USER_ID}/${LIVERY_ID}/spec.mip.gz`,
    ]);
    expect(signs[0].body).toEqual({ expiresIn: 60 });
  });

  it('livery-preview says when the preview file is gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((call) =>
      call.url.includes('/rest/v1/') ? respond(ownRow) : respond({ error: 'not_found' }, 400),
    );
    const result = await handleLiveryProfileIntent(
      'livery-preview',
      env,
      owner,
      form({ livery_id: LIVERY_ID }),
    );
    expect(result.code).toBe('error_MISSING');
  });

  it('set-livery-season maps the per-season limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() =>
      respond({ code: 'P0001', message: 'LIMIT_REACHED: a season holds at most 3 liveries' }, 400),
    );
    const result = await handleLiveryProfileIntent(
      'set-livery-season',
      env,
      owner,
      form({ livery_id: LIVERY_ID, season_id: SEASON_17 }),
    );
    expect(result).toMatchObject({ ok: false, status: 409, code: 'error_LIMIT_REACHED' });
  });

  it('set-livery-active calls the database function', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const result = await handleLiveryProfileIntent(
      'set-livery-active',
      env,
      owner,
      form({ livery_id: LIVERY_ID }),
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe(`${env.url}/rest/v1/rpc/set_my_livery_active`);
    expect(calls[0].body).toEqual({ p_id: LIVERY_ID });
  });

  it('delete-livery removes all four files first, then the row', async () => {
    const calls = stubFetch((call) => (call.method === 'GET' ? respond(ownRow) : respond([])));
    const result = await handleLiveryProfileIntent(
      'delete-livery',
      env,
      owner,
      form({ livery_id: LIVERY_ID }),
    );
    expect(result).toMatchObject({ ok: true, data: { deleted: true } });
    const [, storage, record] = calls;
    expect(storage.url).toBe(`${env.url}/storage/v1/object/liveries`);
    expect((storage.body as { prefixes: string[] }).prefixes).toHaveLength(4);
    expect(record).toMatchObject({ method: 'DELETE' });
    expect(record.url).toContain(`/rest/v1/liveries?id=eq.${LIVERY_ID}&profile_id=eq.${USER_ID}`);
  });

  it('delete-livery keeps the row when the files cannot be removed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubFetch((call) => (call.method === 'GET' ? respond(ownRow) : respond({}, 500)));
    const result = await handleLiveryProfileIntent(
      'delete-livery',
      env,
      owner,
      form({ livery_id: LIVERY_ID }),
    );
    expect(result.code).toBe('error_STORAGE_FAILED');
    expect(calls.some((c) => c.url.includes('/rest/v1/') && c.method === 'DELETE')).toBe(false);
  });

  it('refuses a posted id that is not a UUID without a request', async () => {
    const calls = stubFetch(() => respond([]));
    const result = await handleLiveryProfileIntent(
      'delete-livery',
      env,
      owner,
      form({ livery_id: '1 or 1=1' }),
    );
    expect(result.code).toBe('error_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });
});
