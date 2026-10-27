import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdmin, requireAdminSession, requireFullAdmin, setBroadcaster } from '../../src/lib/auth';

type Locals = App.Locals;

const adminSession = {
  user: { id: 'u-admin', email: 'admin@example.test' },
  profile: {
    id: 'u-admin',
    role: 'admin' as const,
    display_name: 'Admin',
    driver_id: null,
    iracing_cust_id: null,
    iracing_name: null,
    is_broadcaster: false,
    driver_name: null,
  },
  accessToken: 'token-admin',
};

const driverSession = {
  user: { id: 'u-driver', email: 'driver@example.test' },
  profile: { ...adminSession.profile, id: 'u-driver', role: 'driver' as const },
  accessToken: 'token-driver',
};

const staffSession = {
  user: { id: 'u-staff', email: 'staff@example.test' },
  profile: { ...adminSession.profile, id: 'u-staff', role: 'staff' as const },
  accessToken: 'token-staff',
};

const noProfileSession = {
  user: { id: 'u-none', email: null },
  profile: null,
  accessToken: 'token-none',
};

/** Only the fields the helpers read; the rest of App.Locals is irrelevant here. */
function localsWith(session: Locals['session']): Locals {
  return { session, viewAsVisitor: false } as unknown as Locals;
}

/** A fake Astro context whose redirect records its arguments. */
function ctxFor(session: Locals['session'], pathname = '/admin/drivers') {
  const calls: { path: string; status?: number }[] = [];
  const ctx = {
    locals: localsWith(session),
    url: new URL(`https://example.test${pathname}`),
    redirect: (path: string, status?: 301 | 302 | 303 | 307 | 308) => {
      calls.push({ path, status });
      return new Response(null, { status: status ?? 302, headers: { Location: path } });
    },
  };
  return { ctx, calls };
}

describe('requireAdmin', () => {
  it('returns the admin session itself', () => {
    const { ctx, calls } = ctxFor(adminSession);
    expect(requireAdmin(ctx)).toBe(adminSession);
    expect(calls).toEqual([]);
  });

  it('redirects to the login page with a 302 when there is no session', () => {
    const { ctx, calls } = ctxFor(null);
    const result = requireAdmin(ctx);
    expect(result).toBeInstanceOf(Response);
    expect(calls).toEqual([{ path: '/login?next=%2Fadmin%2Fdrivers', status: 302 }]);
  });

  it('redirects a signed-in non-admin', () => {
    const { ctx, calls } = ctxFor(driverSession);
    expect(requireAdmin(ctx)).toBeInstanceOf(Response);
    expect(calls).toEqual([{ path: '/login?next=%2Fadmin%2Fdrivers', status: 302 }]);
  });

  it('redirects a session whose profile is null', () => {
    const { ctx, calls } = ctxFor(noProfileSession);
    expect(requireAdmin(ctx)).toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(302);
  });

  it('encodes special characters in the path', () => {
    const { ctx, calls } = ctxFor(null, '/admin/news/a%20b&c');
    requireAdmin(ctx);
    expect(calls[0].path).toBe('/login?next=' + encodeURIComponent('/admin/news/a%20b&c'));
    expect(calls[0].path).toBe('/login?next=%2Fadmin%2Fnews%2Fa%2520b%26c');
  });
});

describe('requireAdmin for Staff', () => {
  it('lets Staff through, since they have panel access', () => {
    const { ctx, calls } = ctxFor(staffSession);
    expect(requireAdmin(ctx)).toBe(staffSession);
    expect(calls).toEqual([]);
  });
});

describe('requireFullAdmin', () => {
  it('returns the full Admin session itself', () => {
    const { ctx, calls } = ctxFor(adminSession, '/admin/seasons');
    expect(requireFullAdmin(ctx)).toBe(adminSession);
    expect(calls).toEqual([]);
  });

  it('sends Staff back to the dashboard', () => {
    const { ctx, calls } = ctxFor(staffSession, '/admin/seasons');
    expect(requireFullAdmin(ctx)).toBeInstanceOf(Response);
    expect(calls).toEqual([{ path: '/admin', status: 302 }]);
  });

  it('sends a driver or a visitor to the login page', () => {
    for (const session of [driverSession, null]) {
      const { ctx, calls } = ctxFor(session, '/admin/seasons');
      expect(requireFullAdmin(ctx)).toBeInstanceOf(Response);
      expect(calls).toEqual([{ path: '/login?next=%2Fadmin%2Fseasons', status: 302 }]);
    }
  });
});

describe('setBroadcaster', () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

  it('posts the account id, or null to remove the Broadcaster, to admin_set_broadcaster', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await setBroadcaster(env, 'token-admin', 'u-1');
    await setBroadcaster(env, 'token-admin', null);
    expect(fetchMock.mock.calls[0][0]).toBe('https://project.example.test/rest/v1/rpc/admin_set_broadcaster');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-admin');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ p_profile_id: 'u-1' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ p_profile_id: null });
  });

  it("throws with the database's message", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "ACCOUNT_LINKED: Remove this account's driver link first" }), {
          status: 400,
        }),
      ),
    );
    await expect(setBroadcaster(env, 'token-admin', 'u-1')).rejects.toThrow(/^ACCOUNT_LINKED:/);
  });
});

describe('requireAdminSession', () => {
  it('returns null when there is no session', () => {
    expect(requireAdminSession(localsWith(null))).toBeNull();
  });

  it('returns the session for Staff', () => {
    expect(requireAdminSession(localsWith(staffSession))).toBe(staffSession);
  });

  it('returns null for a non-admin role', () => {
    expect(requireAdminSession(localsWith(driverSession))).toBeNull();
  });

  it('returns null for a null profile', () => {
    expect(requireAdminSession(localsWith(noProfileSession))).toBeNull();
  });
});
