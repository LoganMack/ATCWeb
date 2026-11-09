/**
 * The nav status endpoint and the popup's open endpoint (notifications BR1.3, BR2.1), plus the bell script's
 * one-fetch guard and how it fills both badges. GET /api/nav-status refuses a signed-out caller, asks only for
 * the parts the account sees, in parallel, and leaves out a part that failed. fetch is stubbed; no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/pages/api/nav-status';
import { POST } from '../../src/pages/api/notifications/open';
import { applyNavStatus, claimNavStatusFetch } from '../../src/scripts/notificationsBell';

const RUNTIME = {
  env: { PUBLIC_SUPABASE_URL: 'https://db.example.test', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' },
};

type Profile = { driver_id: string | null; role: string };
const session = (profile: Profile) => ({ user: { id: 'u1' }, profile, accessToken: 'user-jwt' });
const driver = session({ driver_id: 'd1', role: 'driver' });
const staffNoDriver = session({ driver_id: null, role: 'staff' });
const adminDriver = session({ driver_id: 'd2', role: 'admin' });
const noDriver = session({ driver_id: null, role: 'driver' });

function ctx(sess: unknown, viewAsVisitor = false) {
  return { locals: { session: sess, runtime: RUNTIME, viewAsVisitor } } as unknown as Parameters<typeof GET>[0];
}

/** Answers by path: the unread RPC, the pending sign-ups read, or the open RPC. */
function stubFetch(answers: { unread?: Response; pending?: Response; open?: Response }): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    urls.push(String(input));
    if (input.includes('rpc/notification_unread_count')) return answers.unread ?? new Response('0');
    if (input.includes('signup_requests')) return answers.pending ?? new Response('[]');
    if (input.includes('rpc/open_my_notifications')) return answers.open ?? new Response('{}');
    throw new Error(`unexpected request ${input}`);
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/nav-status (BR1.3)', () => {
  it('refuses a signed-out caller with 401 and reads nothing', async () => {
    const urls = stubFetch({});
    const res = await GET(ctx(null));
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(urls).toEqual([]);
  });

  it('gives a driver the unread count only', async () => {
    const urls = stubFetch({ unread: new Response('4') });
    const res = await GET(ctx(driver));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ unread: 4 });
    expect(urls).toHaveLength(1);
  });

  it('gives Staff with no driver the pending sign-ups only', async () => {
    const urls = stubFetch({ pending: new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }])) });
    expect(await (await GET(ctx(staffNoDriver))).json()).toEqual({ pendingSignups: 2 });
    expect(urls).toEqual(['https://db.example.test/rest/v1/signup_requests?select=id&status=eq.pending']);
  });

  it('gives an admin with a driver both, and drops the panel part while viewing as a visitor', async () => {
    stubFetch({ unread: new Response('1'), pending: new Response(JSON.stringify([{ id: 'a' }])) });
    expect(await (await GET(ctx(adminDriver))).json()).toEqual({ unread: 1, pendingSignups: 1 });
    // Fresh answers: a Response body can be read only once.
    stubFetch({ unread: new Response('1'), pending: new Response(JSON.stringify([{ id: 'a' }])) });
    expect(await (await GET(ctx(adminDriver, true))).json()).toEqual({ unread: 1 });
  });

  it('asks nothing for an account with no driver and no panel', async () => {
    const urls = stubFetch({});
    expect(await (await GET(ctx(noDriver))).json()).toEqual({});
    expect(urls).toEqual([]);
  });

  it('leaves out a part that failed and still answers 200, logging no token', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch({ unread: new Response('down', { status: 503 }), pending: new Response(JSON.stringify([{ id: 'a' }])) });
    const res = await GET(ctx(adminDriver));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pendingSignups: 1 });
    expect(JSON.stringify(error.mock.calls)).toContain('503');
    expect(JSON.stringify(error.mock.calls)).not.toContain('user-jwt');
  });
});

describe('POST /api/notifications/open (BR2.1)', () => {
  it('refuses a signed-out caller with 401', async () => {
    const urls = stubFetch({});
    expect((await POST(ctx(null))).status).toBe(401);
    expect(urls).toEqual([]);
  });

  it('returns the items with message and link built, and the unread count left', async () => {
    const row = {
      id: 'n1',
      kind: 3,
      created_at: '2026-11-09T12:00:00+00:00',
      was_unread: true,
      subsession_id: 81234567,
      season_label: 'ATC18',
      round_number: null,
      track_name: 'Portland',
      penalty_id: null,
      poll_id: null,
    };
    stubFetch({ open: new Response(JSON.stringify({ items: [row], unread_left: 0 })) });
    const res = await POST(ctx(driver));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      items: [
        {
          id: 'n1',
          kind: 3,
          createdAt: '2026-11-09T12:00:00+00:00',
          unread: true,
          message: 'Incident Appeals now open for ATC18 at Portland',
          href: '/results/81234567/incidents?open=appeal',
        },
      ],
      unread: 0,
    });
  });

  it('answers 502 on a database error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch({ open: new Response('down', { status: 500 }) });
    expect((await POST(ctx(driver))).status).toBe(502);
  });
});

describe('the bell script: one request fills both badges (BR1.2, BR1.3)', () => {
  it('claims the fetch once per page URL, so a second astro:page-load does not refetch', () => {
    const root = { dataset: {} as DOMStringMap };
    expect(claimNavStatusFetch(root, '/results/1/incidents')).toBe(true);
    expect(claimNavStatusFetch(root, '/results/1/incidents')).toBe(false);
    expect(claimNavStatusFetch(root, '/standings')).toBe(true);
  });

  function badge() {
    const hidden = new Set(['hidden']);
    return {
      textContent: '' as string | null,
      classList: {
        toggle: (name: string, force?: boolean) => {
          if (force) hidden.add(name);
          else hidden.delete(name);
          return Boolean(force);
        },
      },
      isHidden: () => hidden.has('hidden'),
    };
  }
  const labelled = () => {
    const attrs: Record<string, string> = {};
    return { setAttribute: (k: string, v: string) => void (attrs[k] = v), attrs };
  };

  it('fills the dot and the gear badge from one response', () => {
    const [dot, gearBadge, bell, gear] = [badge(), badge(), labelled(), labelled()];
    applyNavStatus({ unread: 12, pendingSignups: 1 }, { bell, dot, gear, badge: gearBadge });
    expect([dot.textContent, dot.isHidden(), bell.attrs['aria-label']]).toEqual(['9+', false, 'Notifications (12 unread)']);
    expect([gearBadge.textContent, gearBadge.isHidden(), gear.attrs['aria-label']]).toEqual([
      '1',
      false,
      'Admin Panel (1 pending sign-up)',
    ]);
  });

  it('keeps a badge hidden when its part is missing or zero', () => {
    const [dot, gearBadge, bell, gear] = [badge(), badge(), labelled(), labelled()];
    applyNavStatus({ unread: 0 }, { bell, dot, gear, badge: gearBadge });
    expect([dot.textContent, dot.isHidden(), bell.attrs['aria-label']]).toEqual(['', true, 'Notifications']);
    expect(gearBadge.isHidden()).toBe(true);
    expect(gear.attrs['aria-label']).toBeUndefined();
  });
});
