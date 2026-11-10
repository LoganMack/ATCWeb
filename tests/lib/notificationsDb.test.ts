/**
 * In-site notifications data access (src/lib/db/notifications.ts; notifications BR1.2, BR2.1): each call is
 * one RPC sent with the caller's own token, and a database error or an unexpected answer is thrown to the
 * caller. PostgREST is stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUnreadCount, openNotifications } from '../../src/lib/db/notifications';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };
const TOKEN = 'driver-token';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>, i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getUnreadCount', () => {
  it('calls notification_unread_count as the caller', async () => {
    const fetchMock = stubFetch(respond(3));
    await expect(getUnreadCount(env, TOKEN)).resolves.toBe(3);
    const { url, init, headers } = call(fetchMock);
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/notification_unread_count');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.apikey).toBe('anon-key');
  });

  it('throws on a database error', async () => {
    stubFetch(respond({ code: '42501', message: 'permission denied' }, 401));
    await expect(getUnreadCount(env, TOKEN)).rejects.toThrow(/401 on notification_unread_count/);
  });

  it('throws when the answer is not a number', async () => {
    stubFetch(respond({ count: 3 }));
    await expect(getUnreadCount(env, TOKEN)).rejects.toThrow(/returned/);
  });
});

describe('openNotifications', () => {
  const item = {
    id: 'n1',
    kind: 1,
    created_at: '2026-11-09T12:00:00+00:00',
    was_unread: true,
    subsession_id: 81234567,
    season_label: 'ATC18',
    round_number: 7,
    track_name: 'Portland',
    penalty_id: null,
    poll_id: null,
  };

  it('calls open_my_notifications once, as the caller, and returns the items and unread count left', async () => {
    const fetchMock = stubFetch(respond({ items: [item], unread_left: 2 }));
    await expect(openNotifications(env, TOKEN)).resolves.toEqual({ items: [item], unreadLeft: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, headers } = call(fetchMock);
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/open_my_notifications');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('throws on a database error, so nothing is shown as read', async () => {
    stubFetch(respond('boom', 500));
    await expect(openNotifications(env, TOKEN)).rejects.toThrow(/500 on open_my_notifications/);
  });

  it('throws on an unexpected shape', async () => {
    stubFetch(respond({ items: 'nope' }));
    await expect(openNotifications(env, TOKEN)).rejects.toThrow(/unexpected shape/);
  });
});
