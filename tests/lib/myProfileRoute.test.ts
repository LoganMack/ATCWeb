/**
 * The header's My Profile route (U1 account-onboarding, US2.1): where /my-profile redirects (BR2.2) without
 * any Supabase request (NFR3.2), and that login's `next` handling keeps it (C10).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/pages/my-profile';
import { safeNext } from '../../src/lib/security';

type Locals = App.Locals;
type Session = NonNullable<Locals['session']>;

const profile = {
  id: 'u-1',
  role: 'driver' as const,
  display_name: 'Driver',
  driver_id: null as string | null,
  iracing_cust_id: null,
  iracing_name: null,
  driver_name: null,
};

function sessionWith(driverId: string | null): Session {
  return {
    user: { id: 'u-1', email: 'driver@example.test' },
    profile: { ...profile, driver_id: driverId },
    accessToken: 'token',
  } as unknown as Session;
}

/** A fake endpoint context: the session the middleware resolved and a redirect that records its target. */
function contextFor(session: Locals['session']) {
  const calls: { path: string; status?: number }[] = [];
  const ctx = {
    locals: { session, viewAsVisitor: false } as unknown as Locals,
    redirect: (path: string, status?: number) => {
      calls.push({ path, status });
      return new Response(null, { status: status ?? 302, headers: { Location: path } });
    },
  };
  return { ctx, calls };
}

async function run(session: Locals['session']) {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { ctx, calls } = contextFor(session);
  const response = await GET(ctx as unknown as Parameters<typeof GET>[0]);
  return { response, calls, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('/my-profile', () => {
  it('sends a signed-out visitor to log in, coming back to /my-profile', async () => {
    const { response, calls, fetchMock } = await run(null);
    expect(calls).toEqual([{ path: '/login?next=/my-profile', status: 302 }]);
    expect(response.status).toBe(302);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a signed-in account with a linked driver to that driver page', async () => {
    const { calls, fetchMock } = await run(sessionWith('d-42'));
    expect(calls).toEqual([{ path: '/drivers/d-42', status: 302 }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a signed-in account without a linked driver to the linking page (U2: BR3.2)', async () => {
    const { calls, fetchMock } = await run(sessionWith(null));
    expect(calls).toEqual([{ path: '/link-driver', status: 302 }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the linking page through the login page’s next check (C10)', () => {
    expect(safeNext('/link-driver', '/')).toBe('/link-driver');
  });

  it('survives the login page’s next check', () => {
    const next = new URL('https://example.test/login?next=/my-profile').searchParams.get('next');
    expect(safeNext(next, '/')).toBe('/my-profile');
  });
});
