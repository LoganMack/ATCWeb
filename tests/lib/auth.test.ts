import { describe, expect, it } from 'vitest';
import { requireAdmin, requireAdminSession } from '../../src/lib/auth';

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
    driver_name: null,
  },
  accessToken: 'token-admin',
};

const driverSession = {
  user: { id: 'u-driver', email: 'driver@example.test' },
  profile: { ...adminSession.profile, id: 'u-driver', role: 'driver' as const },
  accessToken: 'token-driver',
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

describe('requireAdminSession', () => {
  it('returns null when there is no session', () => {
    expect(requireAdminSession(localsWith(null))).toBeNull();
  });

  it('returns null for a non-admin role', () => {
    expect(requireAdminSession(localsWith(driverSession))).toBeNull();
  });

  it('returns null for a null profile', () => {
    expect(requireAdminSession(localsWith(noProfileSession))).toBeNull();
  });
});
