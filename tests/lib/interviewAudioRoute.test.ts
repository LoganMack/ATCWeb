/**
 * The interview audio endpoint (driver-profile-polish FR8.2, FR8.4): it refuses a signed-out caller before any
 * request, sends a member to a signed link, answers 404 when the view shows no such interview, and never lets
 * a response be cached. fetch is stubbed; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/pages/api/interviews/[id]/audio';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
  vi.restoreAllMocks();
});

const ID = 'cccccccc-0000-0000-0000-000000000751';
const RUNTIME = {
  env: { PUBLIC_SUPABASE_URL: 'https://db.example.test', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' },
};

function call(session: unknown, id = ID): Promise<Response> {
  const ctx = {
    locals: { session, runtime: RUNTIME, viewAsVisitor: false },
    params: { id },
  };
  return GET(ctx as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

const member = { user: { id: 'u1' }, profile: null, accessToken: 'member-jwt' };

function stubFetch(responses: { status?: number; body: unknown }[]): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(String(input));
    const next = responses[urls.length - 1] ?? { body: [] };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return urls;
}

describe('GET /api/interviews/[id]/audio', () => {
  it('refuses a signed-out caller with 401 and reads nothing', async () => {
    const urls = stubFetch([]);
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(urls).toEqual([]);
  });

  it('redirects a member to the signed link, uncached', async () => {
    stubFetch([
      { body: [{ audio_path: 'd/7.webm' }] },
      { body: { signedURL: '/object/sign/race-interviews/d/7.webm?token=t' } },
    ]);
    const res = await call(member);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      'https://db.example.test/storage/v1/object/sign/race-interviews/d/7.webm?token=t',
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('answers 404 for a hidden or unknown interview and for a malformed id', async () => {
    const urls = stubFetch([{ body: [] }]);
    expect((await call(member)).status).toBe(404);
    expect((await call(member, 'nope')).status).toBe(404);
    expect(urls).toHaveLength(1);
  });

  it('answers 502 when signing fails, without logging the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch([{ body: [{ audio_path: 'd/7.webm' }] }, { status: 500, body: 'down' }]);
    const res = await call(member);
    expect(res.status).toBe(502);
    expect(JSON.stringify(error.mock.calls)).not.toContain('member-jwt');
  });
});
