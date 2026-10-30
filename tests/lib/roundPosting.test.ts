/**
 * Posting and re-posting a round (BR1.1-BR1.12): the date choice a form sends, the activity-log line, the
 * Post Date cell, and what setRoundPosted sends to the database. The site never writes posted_at,
 * first_posted_at or anything about emails: set_round_incident_posted picks the date and the database's own
 * trigger queues the one "Incident Report Posted" email (FR1.6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePostChoice,
  postDateCell,
  postingLogLabel,
  setRoundPosted,
} from '../../src/lib/incidentReports';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
};

afterEach(() => vi.unstubAllGlobals());

describe('parsePostChoice', () => {
  it('reads Reset and Keep original date', () => {
    expect(parsePostChoice(form({ date: 'reset' }))).toBe('reset');
    expect(parsePostChoice(form({ date: 'keep' }))).toBe('keep');
  });

  it('treats no choice (no script) and anything unknown as Reset', () => {
    expect(parsePostChoice(form({}))).toBe('reset');
    expect(parsePostChoice(form({ date: 'KEEP' }))).toBe('reset');
    expect(parsePostChoice(form({ date: '1' }))).toBe('reset');
  });
});

describe('postingLogLabel', () => {
  it('names a first post, a reset, a keep and an unpost, with the track', () => {
    expect(postingLogLabel(true, false, 'reset', 'Portland')).toBe('Posted incident report — Portland');
    expect(postingLogLabel(true, false, 'keep', 'Portland')).toBe('Posted incident report — Portland');
    expect(postingLogLabel(true, true, 'reset', 'Portland')).toBe(
      'Re-posted incident report (new post date) — Portland',
    );
    expect(postingLogLabel(true, true, 'keep', 'Portland')).toBe(
      'Re-posted incident report (original post date kept) — Portland',
    );
    expect(postingLogLabel(false, true, 'reset', 'Portland')).toBe('Unposted incident report — Portland');
  });

  it('leaves the track off when there is none', () => {
    expect(postingLogLabel(false, false, 'reset', '')).toBe('Unposted incident report');
  });
});

describe('postDateCell', () => {
  it('shows the post date while posted', () => {
    expect(
      postDateCell({
        posted: true,
        posted_at: '2026-06-01T20:00:00Z',
        first_posted_at: '2026-05-01T20:00:00Z',
      }),
    ).toEqual({ date: '2026-06-01T20:00:00Z', muted: false });
  });

  it('shows the last post date muted once unposted, else the first', () => {
    expect(
      postDateCell({
        posted: false,
        posted_at: '2026-06-01T20:00:00Z',
        first_posted_at: '2026-05-01T20:00:00Z',
      }),
    ).toEqual({ date: '2026-06-01T20:00:00Z', muted: true });
    expect(postDateCell({ posted: false, posted_at: null, first_posted_at: '2026-05-01T20:00:00Z' })).toEqual(
      { date: '2026-05-01T20:00:00Z', muted: true },
    );
  });

  it('shows nothing for a round never posted', () => {
    expect(postDateCell(undefined)).toBeNull();
    expect(postDateCell({ posted: false, posted_at: null, first_posted_at: null })).toBeNull();
  });
});

describe('setRoundPosted', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each([
    ['Reset', { posted: true, resetDate: true }],
    ['Keep', { posted: true, resetDate: false }],
    ['unpost', { posted: false, resetDate: true }],
  ])('sends only the round, the flag and the choice (%s)', async (_label, choice) => {
    const fetchMock = stubFetch({ posted: choice.posted, reset: false, first_post: false });
    await setRoundPosted(env, 'steward-token', 77, choice);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/set_round_incident_posted');
    expect(init.headers.Authorization).toBe('Bearer steward-token');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ p_subsession_id: 77, p_posted: choice.posted, p_reset_date: choice.resetDate });
    expect(init.body).not.toMatch(/posted_at|first_posted|email|outbox/);
  });

  it("returns the database's answer about the date", async () => {
    stubFetch({ posted: true, reset: true, first_post: true, posted_at: '2026-06-01T20:00:00Z' });
    await expect(setRoundPosted(env, 't', 77, { posted: true, resetDate: false })).resolves.toEqual({
      posted: true,
      reset: true,
      firstPost: true,
    });
  });

  it('throws when the database refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"code":"42501","message":"Only an admin or staff member can post a round"}', {
          status: 403,
        }),
      ),
    );
    await expect(setRoundPosted(env, 't', 77, { posted: true, resetDate: true })).rejects.toThrow(
      /Only an admin or staff member can post a round/,
    );
  });
});
