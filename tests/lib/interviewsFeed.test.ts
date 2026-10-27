/**
 * History > Interviews data access (driver-profile-polish FR8.2-FR8.4): the list and the play link read
 * race_interviews_shown with the member's own token, and a play link is signed for 300 seconds only when the
 * view shows that interview. fetch is stubbed; no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatInterviewLength,
  getMemberInterviews,
  signMemberInterviewAudio,
} from '../../src/lib/interviewsFeed';
import type { SupabaseEnv } from '../../src/lib/db/client';

const blocked = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = blocked;
});

const ENV: SupabaseEnv = { url: 'https://db.example.test', anonKey: 'anon-key' };
const ID = 'cccccccc-0000-0000-0000-000000000751';

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}

/** Answers each call with the next response from the list. */
function stubFetch(responses: { status?: number; body: unknown }[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      url: decodeURIComponent(String(input)),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = responses[calls.length - 1] ?? { body: [] };
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe('getMemberInterviews', () => {
  it('reads race_interviews_shown with the member’s token, newest first', async () => {
    const calls = stubFetch([{ body: [{ id: ID, drivers: null }] }]);
    const rows = await getMemberInterviews(ENV, 'member-jwt', [7, 8]);
    expect(rows).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/race_interviews_shown?select=');
    expect(calls[0].url).toContain('subsession_id=in.(7,8)');
    expect(calls[0].url).toContain('order=created_at.desc');
    expect(calls[0].auth).toBe('Bearer member-jwt');
  });

  it('reads nothing for an empty season', async () => {
    const calls = stubFetch([]);
    expect(await getMemberInterviews(ENV, 'member-jwt', [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('throws when the read fails', async () => {
    stubFetch([{ status: 401, body: 'denied' }]);
    await expect(getMemberInterviews(ENV, 'member-jwt', [7])).rejects.toThrow(/Supabase REST error 401/);
  });
});

describe('signMemberInterviewAudio', () => {
  it('signs the shown interview’s audio for 300 seconds with the member’s token', async () => {
    const calls = stubFetch([
      { body: [{ audio_path: 'driver/7.webm' }] },
      { body: { signedURL: '/object/sign/race-interviews/driver/7.webm?token=t' } },
    ]);
    const url = await signMemberInterviewAudio(ENV, 'member-jwt', ID);
    expect(url).toBe('https://db.example.test/storage/v1/object/sign/race-interviews/driver/7.webm?token=t');
    expect(calls[0].url).toContain(`race_interviews_shown?select=audio_path&id=eq.${ID}`);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://db.example.test/storage/v1/object/sign/race-interviews/driver/7.webm',
      auth: 'Bearer member-jwt',
    });
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ expiresIn: 300 });
  });

  it('returns null without signing when the view shows no row (hidden driver or unknown id)', async () => {
    const calls = stubFetch([{ body: [] }]);
    expect(await signMemberInterviewAudio(ENV, 'member-jwt', ID)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null for a malformed id without any call', async () => {
    const calls = stubFetch([]);
    expect(await signMemberInterviewAudio(ENV, 'member-jwt', '../etc')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('throws when signing is refused', async () => {
    stubFetch([{ body: [{ audio_path: 'driver/7.webm' }] }, { status: 400, body: 'nope' }]);
    await expect(signMemberInterviewAudio(ENV, 'member-jwt', ID)).rejects.toThrow(/sign failed \(400\)/);
  });
});

describe('formatInterviewLength', () => {
  it('shows m:ss', () => {
    expect(formatInterviewLength(65)).toBe('1:05');
    expect(formatInterviewLength(9)).toBe('0:09');
  });
});
