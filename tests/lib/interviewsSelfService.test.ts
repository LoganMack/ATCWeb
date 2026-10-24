/**
 * Interviews on the own profile (U6 interviews): the list with its round labels and window flag (BR12.1,
 * BR12.6, BR12.8), the download link and its cleaned file name (BR12.3, NFR1.7), every delete outcome with
 * the file removed first (BR12.4, NFR4.1), the admin delete's not-found handling (BR12.5, NFR4.2), the profile
 * intents in JSON and redirect form (NFR1.6) and logs that carry step, status and id only (NFR9.1). Storage
 * and PostgREST are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteMyInterview,
  deleteRaceInterview,
  getMyInterviews,
  interviewDownloadName,
  interviewRoundLabel,
  interviewStatusMessage,
  loadMyInterviews,
  signMyInterviewDownload,
} from '../../src/lib/raceInterviews';
import { handleProfilePost, type ProfilePostContext } from '../../src/lib/driverAccount';
import { deleteConfirmLines, downloadUrlOf } from '../../src/scripts/interviews';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const USER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DRIVER_ID = '11111111-2222-4333-8444-555555555555';
const INTERVIEW_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const PATH = `${DRIVER_ID}/9001.webm`;
const TOKEN = 'user-token';
const owner = { accessToken: TOKEN, userId: USER_ID };
const NOW = new Date('2026-10-24T12:00:00Z');

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
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
        body: init.body,
        auth: new Headers(init.headers).get('Authorization'),
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function captureLogs(): () => string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const dbRow = {
  id: INTERVIEW_ID,
  subsession_id: 9001,
  audio_path: PATH,
  audio_type: 'audio/webm',
  duration_seconds: 42,
  created_at: '2026-10-23T20:00:00Z',
};
const round = {
  subsession_id: 9001,
  season_label: 'ATC 18',
  round_number: 3,
  track_name: 'Spa',
  start_time: '2026-10-22T18:00:00Z',
};

/** Storage and PostgREST as a happy owner sees them; `over` replaces any one answer by a URL fragment. */
function storage(over: Record<string, () => Response> = {}): (call: Call) => Response {
  return (call) => {
    for (const [fragment, answer] of Object.entries(over)) if (call.url.includes(fragment)) return answer();
    if (call.url.includes('/rest/v1/race_interviews')) return respond([dbRow]);
    if (call.url.includes('/rest/v1/curated_rounds')) return respond([round]);
    if (call.url.includes('/storage/v1/object/sign/'))
      return respond({ signedURL: `/object/sign/race-interviews/${PATH}?token=t0k` });
    if (call.url.endsWith('/storage/v1/object/race-interviews')) return respond([{ name: PATH }]);
    if (call.url.includes('/rpc/my_interview_audio_exists')) return respond(false);
    if (call.url.includes('/rpc/delete_my_interview_record')) return new Response(null, { status: 204 });
    return respond({ message: 'unexpected' }, 500);
  };
}

describe('the Interviews list (BR12.1, BR12.6, BR12.8)', () => {
  it('reads the owner’s rows newest first, then the round labels in one public read', async () => {
    const calls = stubFetch(storage());
    const rows = await getMyInterviews(env, owner, NOW);
    expect(rows).toEqual([
      {
        id: INTERVIEW_ID,
        subsessionId: 9001,
        roundLabel: 'ATC 18 · Round 3 · Spa',
        roundHref: '/results/9001',
        createdAt: '2026-10-23T20:00:00Z',
        durationSeconds: 42,
        windowOpen: true,
      },
    ]);
    expect(calls).toHaveLength(2);
    const list = decodeURIComponent(calls[0].url);
    expect(list).toContain(`submitter_id=eq.${USER_ID}`);
    expect(list).toContain('order=created_at.desc&limit=200');
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(decodeURIComponent(calls[1].url)).toContain('subsession_id=in.(9001)');
    expect(calls[1].auth).toBe('Bearer anon-key');
  });

  it('makes no round read for an empty list, and marks a closed window and an unknown round', async () => {
    const empty = stubFetch(() => respond([]));
    expect(await getMyInterviews(env, owner, NOW)).toEqual([]);
    expect(empty).toHaveLength(1);

    stubFetch(storage({ curated_rounds: () => respond([{ ...round, start_time: '2026-10-01T18:00:00Z' }]) }));
    expect((await getMyInterviews(env, owner, NOW))[0].windowOpen).toBe(false);

    stubFetch(storage({ curated_rounds: () => respond([]) }));
    expect((await getMyInterviews(env, owner, NOW))[0]).toMatchObject({
      roundLabel: 'Round 9001',
      windowOpen: null,
    });
  });

  it('returns null with a status-only log when the list cannot be read (NFR4.3)', async () => {
    const logs = captureLogs();
    stubFetch(() => respond({ message: `secret ${PATH}` }, 503));
    expect(await loadMyInterviews(env, owner)).toBeNull();
    expect(logs()).toBe('interviews load failed read 503');
  });

  it('labels a round from its season, number and track', () => {
    expect(interviewRoundLabel(9001, round)).toBe('ATC 18 · Round 3 · Spa');
    expect(interviewRoundLabel(9001, { ...round, season_label: null, round_number: null })).toBe('Spa');
    expect(interviewRoundLabel(9001, undefined)).toBe('Round 9001');
  });
});

describe('download (BR12.3, NFR1.7)', () => {
  it('signs a 60-second link with the owner’s token and adds a clean, encoded file name', async () => {
    const calls = stubFetch(storage());
    const signed = await signMyInterviewDownload(env, owner, INTERVIEW_ID);
    expect(signed).toEqual({
      ok: true,
      url: `${env.url}/storage/v1/object/sign/race-interviews/${PATH}?token=t0k&download=interview-atc-18-round-3.webm`,
    });
    const sign = calls.find((c) => c.url.includes('/object/sign/'))!;
    expect(sign.method).toBe('POST');
    expect(JSON.parse(sign.body as string)).toEqual({ expiresIn: 60 });
    expect(sign.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('reduces the name to [a-z0-9-] and keeps the file’s own extension', () => {
    const row = { subsession_id: 9001, audio_path: `${DRIVER_ID}/9001.ogg`, audio_type: 'audio/ogg' };
    expect(interviewDownloadName(row, { ...round, season_label: 'ATC <18> "Spring" / Été' })).toBe(
      'interview-atc-18-spring-t-round-3.ogg',
    );
    expect(
      interviewDownloadName({ ...row, audio_path: 'x/9001.bin', audio_type: 'audio/mp4' }, undefined),
    ).toBe('interview-9001.mp4');
  });

  it('reports a missing file, a refused signing and a row that is not the owner’s, and never logs the link', async () => {
    const logs = captureLogs();
    stubFetch(
      storage({
        '/object/sign/': () =>
          respond({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400),
      }),
    );
    expect(await signMyInterviewDownload(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'MISSING' });
    stubFetch(storage({ '/object/sign/': () => respond({ message: 'denied' }, 403) }));
    expect(await signMyInterviewDownload(env, owner, INTERVIEW_ID)).toEqual({
      ok: false,
      code: 'SIGN_FAILED',
    });
    stubFetch(storage({ race_interviews: () => respond([]) }));
    expect(await signMyInterviewDownload(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(logs()).toBe(
      `download-interview failed sign 400 ${INTERVIEW_ID}\ndownload-interview failed sign 403 ${INTERVIEW_ID}`,
    );
  });
});

describe('delete (BR12.4, NFR3.2, NFR4.1, NFR9.1)', () => {
  it('removes the file through the bulk delete, then the record', async () => {
    const calls = stubFetch(storage());
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: true });
    const steps = calls.map((c) => `${c.method} ${c.url.replace(env.url, '').split('?')[0]}`);
    expect(steps).toEqual([
      'GET /rest/v1/race_interviews',
      'DELETE /storage/v1/object/race-interviews',
      'POST /rest/v1/rpc/delete_my_interview_record',
    ]);
    expect(JSON.parse(calls[1].body as string)).toEqual({ prefixes: [PATH] });
    expect(calls[1].auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[2].body as string)).toEqual({ p_id: INTERVIEW_ID });
  });

  it('treats an empty delete list as success only when the file is confirmed gone', async () => {
    const calls = stubFetch(storage({ 'object/race-interviews': () => respond([]) }));
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: true });
    expect(calls.map((c) => c.url.split('/').pop())).toContain('my_interview_audio_exists');
    expect(calls).toHaveLength(4);
  });

  it('keeps the record when the delete was refused or failed, and logs step, status and id only', async () => {
    const logs = captureLogs();
    const refused = stubFetch(
      storage({
        'object/race-interviews': () => respond([]),
        my_interview_audio_exists: () => respond(true),
      }),
    );
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'STORAGE_FAILED' });
    expect(refused.some((c) => c.url.includes('delete_my_interview_record'))).toBe(false);

    const failed = stubFetch(storage({ 'object/race-interviews': () => respond({ message: 'boom' }, 500) }));
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'STORAGE_FAILED' });
    expect(failed).toHaveLength(2);

    expect(logs()).toBe(
      `delete-interview failed exists 200 ${INTERVIEW_ID}\ndelete-interview failed storage 500 ${INTERVIEW_ID}`,
    );
    expect(logs()).not.toContain(PATH);
  });

  it('reports a failed record delete after the file went, and a retry then completes', async () => {
    captureLogs();
    stubFetch(storage({ delete_my_interview_record: () => respond({ message: 'FILE_EXISTS: no' }, 400) }));
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'RECORD_FAILED' });
    stubFetch(storage({ 'object/race-interviews': () => respond([]) }));
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: true });
  });

  it('refuses a malformed id or someone else’s row without touching storage', async () => {
    const calls = stubFetch(storage({ race_interviews: () => respond([]) }));
    expect(await deleteMyInterview(env, owner, 'not-a-uuid')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(calls).toHaveLength(0);
    expect(await deleteMyInterview(env, owner, INTERVIEW_ID)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(calls.some((c) => c.url.includes('/storage/'))).toBe(false);
  });
});

describe('admin delete (BR12.5, NFR4.2)', () => {
  const target = { id: INTERVIEW_ID, audio_path: PATH };
  const admin = (over: Record<string, () => Response>) =>
    storage({ 'rest/v1/race_interviews': () => new Response(null, { status: 204 }), ...over });

  it('deletes the record after the file is removed', async () => {
    const calls = stubFetch(admin({}));
    await deleteRaceInterview(env, 'admin-token', target);
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('treats an explicit not-found as gone, and throws on anything else before the record', async () => {
    const gone = stubFetch(
      admin({
        'object/race-interviews': () => respond([]),
        '/object/info/': () => respond({ error: 'not_found' }, 404),
      }),
    );
    await deleteRaceInterview(env, 'admin-token', target);
    expect(gone.at(-1)?.url).toContain('/rest/v1/race_interviews?id=eq.');

    for (const info of [() => respond({ name: PATH }), () => respond({ message: 'down' }, 503)]) {
      const calls = stubFetch(admin({ 'object/race-interviews': () => respond([]), '/object/info/': info }));
      await expect(deleteRaceInterview(env, 'admin-token', target)).rejects.toThrow();
      expect(calls.some((c) => c.url.includes('/rest/v1/race_interviews'))).toBe(false);
    }
    const failed = stubFetch(admin({ 'object/race-interviews': () => respond({ message: 'no' }, 500) }));
    await expect(deleteRaceInterview(env, 'admin-token', target)).rejects.toThrow('(500)');
    expect(failed).toHaveLength(1);
  });
});

describe('the profile intents (C4, NFR1.6)', () => {
  function context(
    fields: Record<string, string>,
    overrides: Partial<ProfilePostContext> = {},
  ): ProfilePostContext {
    const form = new FormData();
    form.append('intent', 'save-profile');
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return {
      env,
      session: { accessToken: TOKEN, user: { id: USER_ID, email: 'ana@example.test', newEmail: null } },
      isOwner: true,
      driverId: DRIVER_ID,
      origin: 'https://atc.example.test',
      json: true,
      form,
      ...overrides,
    };
  }
  const del = { intent: 'delete-interview', interview_id: INTERVIEW_ID };
  const download = { intent: 'download-interview', interview_id: INTERVIEW_ID };

  it('answers a delete with C4 JSON, and redirects to the tab without JavaScript', async () => {
    stubFetch(storage());
    expect(await handleProfilePost(context(del))).toEqual({
      kind: 'json',
      status: 200,
      body: { ok: true, message: 'Interview deleted.', data: { id: INTERVIEW_ID, deleted: true } },
    });
    expect(await handleProfilePost(context(del, { json: false }))).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}?edit=1&tab=interviews&interview_status=deleted`,
    });
  });

  it('maps a failure to its message and status, in JSON and in the redirect', async () => {
    captureLogs();
    stubFetch(storage({ 'object/race-interviews': () => respond({}, 500) }));
    expect(await handleProfilePost(context(del))).toEqual({
      kind: 'json',
      status: 502,
      body: { ok: false, message: "Couldn't delete the audio file, so your interview was kept. Try again." },
    });
    const redirect = await handleProfilePost(context(del, { json: false }));
    expect(redirect).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}?edit=1&tab=interviews&interview_status=delete_STORAGE_FAILED`,
    });
    expect(interviewStatusMessage('delete_STORAGE_FAILED')).toEqual({
      ok: false,
      message: "Couldn't delete the audio file, so your interview was kept. Try again.",
    });
    expect(interviewStatusMessage('deleted')).toEqual({ ok: true, message: 'Interview deleted.' });
    expect(interviewStatusMessage('<script>')).toBeNull();
  });

  it('answers a download with the signed link, or redirects straight to it without JavaScript', async () => {
    stubFetch(storage());
    const json = await handleProfilePost(context(download));
    expect(json).toMatchObject({ kind: 'json', status: 200, body: { ok: true, data: { id: INTERVIEW_ID } } });
    if (json.kind !== 'json') throw new Error('expected a JSON answer');
    const url = String(json.body.data?.url);
    expect(url).toContain('download=interview-atc-18-round-3.webm');
    expect(await handleProfilePost(context(download, { json: false }))).toEqual({
      kind: 'redirect',
      location: url,
    });
  });

  it('refuses the intents to anyone but the owner without calling storage', async () => {
    const calls = stubFetch(storage());
    expect(await handleProfilePost(context(del, { isOwner: false }))).toMatchObject({
      kind: 'json',
      status: 403,
    });
    expect(await handleProfilePost(context(download, { session: null }))).toMatchObject({
      kind: 'json',
      status: 403,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('the tab script’s helpers (BR12.4, BR12.8)', () => {
  it('names the round in the confirm text and adds the closed-window line', () => {
    expect(deleteConfirmLines('ATC 18 · Round 3 · Spa', true)).toEqual([
      "Delete your interview for ATC 18 · Round 3 · Spa? This can't be undone.",
    ]);
    expect(deleteConfirmLines('Spa', false)).toEqual([
      "Delete your interview for Spa? This can't be undone.",
      "You can't record a new one for this round any more.",
    ]);
    expect(deleteConfirmLines('Spa', null)).toHaveLength(1);
  });

  it('follows only a web link from a successful download answer', () => {
    expect(
      downloadUrlOf({ ok: true, message: '', data: { url: 'https://db.example.test/x?download=a.webm' } }),
    ).toBe('https://db.example.test/x?download=a.webm');
    expect(downloadUrlOf({ ok: true, message: '', data: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(
      downloadUrlOf({ ok: false, message: 'no', data: { url: 'https://db.example.test/x' } }),
    ).toBeNull();
    expect(downloadUrlOf({ ok: true, message: '' })).toBeNull();
  });
});
