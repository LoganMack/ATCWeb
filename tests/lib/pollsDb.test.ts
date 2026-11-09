/**
 * Polls data access and the save workflow (src/lib/db/polls.ts, src/lib/polls/save.ts; polls BR2.5, BR3.3,
 * BR4.2, BR5.5): request shapes, every database error mapped to its message, the explicit posted filter on the
 * public read, and file cleanup after a save. PostgREST and Storage are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_UNKNOWN_ERROR,
  PollError,
  getPollForEdit,
  getPostedPoll,
  listPollsForAdmin,
  pollErrorMessage,
  pollToView,
  savePoll,
  setPollPosted,
} from '../../src/lib/db/polls';
import { deletePollWithFiles, savePollFromForm } from '../../src/lib/polls/save';
import { listStorageFolder } from '../../src/lib/db/assets';
import type { PollForm } from '../../src/lib/polls/validate';

const env = { url: 'https://project.supabase.co', anonKey: 'anon-key' };
const TOKEN = 'admin-token';
const POLL_ID = '11111111-2222-4333-8444-555555555555';
const UPDATED_AT = '2026-11-15T11:00:00.123456+00:00';

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const raised = (message: string) => respond({ code: 'P0001', message, details: null, hint: null }, 400);

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof vi.fn>, i: number) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit | undefined];
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
  return { url: new URL(url), init, body };
};

function image(type: string): File {
  return new File(['x'], 'pic', { type });
}

function form(overrides: Partial<PollForm> = {}): PollForm {
  return {
    title: ' Next season ',
    description: '',
    closesAt: '',
    isScheduleVote: false,
    expectedUpdatedAt: UPDATED_AT,
    sections: [
      {
        id: null,
        key: 's1',
        name: 'Track',
        answerType: 'single',
        options: [
          { id: null, key: 'a', name: 'Spa', imagePath: null, removeImage: false, file: image('image/png') },
          { id: null, key: 'b', name: 'Monza', imagePath: null, removeImage: false, file: null },
        ],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reads', () => {
  it('reads the posted poll with an explicit status filter and no created_by (BR3.3)', async () => {
    const fetchMock = stubFetch(respond([]));
    expect(await getPostedPoll(env, POLL_ID)).toBeNull();
    const { url } = call(fetchMock, 0);
    expect(url.pathname).toBe('/rest/v1/polls');
    expect(url.searchParams.get('id')).toBe(`eq.${POLL_ID}`);
    expect(url.searchParams.get('status')).toBe('eq.posted');
    expect(url.searchParams.get('select')).not.toContain('created_by');
  });

  it('never queries for an id that is not a uuid', async () => {
    const fetchMock = stubFetch();
    expect(await getPostedPoll(env, 'abc,status.eq.draft')).toBeNull();
    expect(await getPollForEdit(env, TOKEN, '../x')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sorts sections and options by position and builds resized image URLs', async () => {
    stubFetch(
      respond([
        {
          id: POLL_ID, title: 'T', description: null, closes_at: null, is_schedule_vote: false, status: 'draft',
          posted_at: null, first_posted_at: null, created_at: UPDATED_AT, updated_at: UPDATED_AT,
          poll_sections: [
            { id: 's2', name: 'Second', answer_type: 'stars', position: 1, poll_options: [{ id: 'c', name: 'C', image_path: null, position: 0 }] },
            {
              id: 's1', name: 'First', answer_type: 'single', position: 0,
              poll_options: [
                { id: 'b', name: 'B', image_path: null, position: 1 },
                { id: 'a', name: 'A', image_path: `${POLL_ID}/a-1.png`, position: 0 },
              ],
            },
          ],
        },
      ]),
    );
    const poll = (await getPollForEdit(env, TOKEN, POLL_ID))!;
    expect(poll.updated_at).toBe(UPDATED_AT);
    expect(poll.sections.map((s) => s.name)).toEqual(['First', 'Second']);
    expect(poll.sections[0].options.map((o) => o.name)).toEqual(['A', 'B']);
    const view = pollToView(poll, env.url, 320);
    expect(view.sections[0].options[0].imageUrl).toBe(
      `/cdn-cgi/image/format=auto,fit=scale-down,width=320/https://project.supabase.co/storage/v1/object/public/poll-images/${POLL_ID}/a-1.png`,
    );
    expect(view.sections[0].options[1].imageUrl).toBeNull();
  });

  it('lists polls newest first with the admin token', async () => {
    const fetchMock = stubFetch(respond([]));
    await listPollsForAdmin(env, TOKEN);
    const { url, init } = call(fetchMock, 0);
    expect(url.searchParams.get('order')).toBe('created_at.desc');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('writes', () => {
  it('sends save_poll the id, the loaded updated_at as text and the payload', async () => {
    const fetchMock = stubFetch(respond([`${POLL_ID}/old-1.png`]));
    const payload = { title: 'T', description: null, closes_at: null, is_schedule_vote: false, sections: [] };
    expect(await savePoll(env, TOKEN, POLL_ID, UPDATED_AT, payload)).toEqual([`${POLL_ID}/old-1.png`]);
    const { url, init, body } = call(fetchMock, 0);
    expect(url.pathname).toBe('/rest/v1/rpc/save_poll');
    expect(init?.method).toBe('POST');
    expect(body).toEqual({ p_poll_id: POLL_ID, p_expected_updated_at: UPDATED_AT, p_poll: payload });
  });

  it('maps each refusal to its message (BR2.2, BR2.5, BR5.3, BR5.5)', async () => {
    const cases: [string, string][] = [
      ['not_allowed', 'Only a full admin can change polls.'],
      ['not_found', 'That poll no longer exists.'],
      ['stale', 'Someone else saved this poll since you opened it. Reload to see their changes.'],
      ['closing_passed', "This poll's closing date has passed. Change it before posting."],
      ['posted_cannot_delete', 'Unpost the poll before deleting it.'],
      ['locked_by_votes', 'This poll has votes, so its questions and options can no longer change.'],
    ];
    for (const [code, message] of cases) {
      stubFetch(raised(code));
      const err = await setPollPosted(env, TOKEN, POLL_ID, true).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PollError);
      expect((err as PollError).code).toBe(code);
      expect((err as PollError).message).toBe(message);
    }
  });

  it('describes invalid fields and falls back for anything unknown', () => {
    expect(pollErrorMessage('invalid:section.2.option.3.name:duplicate')).toBe(
      'Section 2, option 3: this name is already an option in this section.',
    );
    expect(pollErrorMessage('invalid:section.1.options:count')).toBe(
      'Section 1: this answer type needs a different number of options.',
    );
    expect(pollErrorMessage('invalid:closes_at:past')).toBe('The closing date must be in the future.');
    expect(pollErrorMessage('invalid:section.1.option.1.image:path')).toBe('Section 1, option 1: the image is not valid.');
    expect(pollErrorMessage('boom')).toBe(POLL_UNKNOWN_ERROR);
  });

  it('logs an unknown failure and still throws a PollError', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(respond('gateway down', 502));
    const err = (await setPollPosted(env, TOKEN, POLL_ID, false).catch((e: unknown) => e)) as PollError;
    expect(err.code).toBe('http_502');
    expect(err.message).toBe(POLL_UNKNOWN_ERROR);
    expect(log).toHaveBeenCalled();
  });
});

describe('savePollFromForm (W1, W2, BR4.2)', () => {
  it('creates, uploads under the new folder, saves and returns the new id', async () => {
    const fetchMock = stubFetch(respond(JSON.stringify(POLL_ID)), respond([{ updated_at: UPDATED_AT }]), respond({}), respond([]));
    expect(await savePollFromForm(env, TOKEN, null, form())).toEqual({ pollId: POLL_ID, created: true });
    expect(call(fetchMock, 0).url.pathname).toBe('/rest/v1/rpc/create_poll');
    expect(call(fetchMock, 0).body).toEqual({ p_title: 'Next season' });
    expect(call(fetchMock, 2).url.pathname).toMatch(new RegExp(`^/storage/v1/object/poll-images/${POLL_ID}/a-\\d+\\.png$`));
    const save = call(fetchMock, 3);
    expect(save.body.p_expected_updated_at).toBe(UPDATED_AT);
    expect(save.body.p_poll.sections[0].options[0].image_path).toMatch(new RegExp(`^${POLL_ID}/a-\\d+\\.png$`));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('deletes the files it uploaded when the save is refused, and keeps the existing poll', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubFetch(respond({}), raised('stale'), respond([]));
    const err = (await savePollFromForm(env, TOKEN, POLL_ID, form()).catch((e: unknown) => e)) as PollError;
    expect(err.code).toBe('stale');
    const cleanup = call(fetchMock, 2);
    expect(cleanup.url.pathname).toBe('/storage/v1/object/poll-images');
    expect(cleanup.init?.method).toBe('DELETE');
    expect(cleanup.body.prefixes).toHaveLength(1);
    expect(cleanup.body.prefixes[0]).toMatch(new RegExp(`^${POLL_ID}/a-\\d+\\.png$`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('removes the new draft too when the first save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubFetch(
      respond(JSON.stringify(POLL_ID)),
      respond([{ updated_at: UPDATED_AT }]),
      respond({}),
      raised('invalid:section.1.options:count'),
      respond([]),
      respond(''),
    );
    await expect(savePollFromForm(env, TOKEN, null, form())).rejects.toThrow('Section 1:');
    expect(call(fetchMock, 4).init?.method).toBe('DELETE');
    expect(call(fetchMock, 5).url.pathname).toBe('/rest/v1/rpc/delete_poll');
  });

  it('deletes the files the save no longer uses', async () => {
    const fetchMock = stubFetch(respond([`${POLL_ID}/old-1.png`]), respond([]));
    await savePollFromForm(env, TOKEN, POLL_ID, form({ sections: [{ ...form().sections[0], options: form().sections[0].options.map((o) => ({ ...o, file: null })) }] }));
    expect(call(fetchMock, 0).url.pathname).toBe('/rest/v1/rpc/save_poll');
    expect(call(fetchMock, 1).body).toEqual({ prefixes: [`${POLL_ID}/old-1.png`] });
  });

  it('names the option when an upload fails and saves nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubFetch(respond('too big', 413));
    await expect(savePollFromForm(env, TOKEN, POLL_ID, form())).rejects.toThrow(
      'Section 1, option 1: the image could not be uploaded. Try again.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('deletePollWithFiles (BR2.5)', () => {
  it('deletes the poll, lists its folder and deletes every file', async () => {
    const fetchMock = stubFetch(
      respond(''),
      respond([{ name: 'a-1.png', id: 'x' }, { name: 'sub', id: null }]),
      respond([]),
    );
    await deletePollWithFiles(env, TOKEN, POLL_ID);
    expect(call(fetchMock, 0).url.pathname).toBe('/rest/v1/rpc/delete_poll');
    expect(call(fetchMock, 1).url.pathname).toBe('/storage/v1/object/list/poll-images');
    expect(call(fetchMock, 1).body).toEqual({ prefix: POLL_ID, limit: 1000, offset: 0 });
    expect(call(fetchMock, 2).body).toEqual({ prefixes: [`${POLL_ID}/a-1.png`] });
  });

  it('keeps the delete when listing the files fails, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(respond(''), respond('nope', 500));
    await expect(deletePollWithFiles(env, TOKEN, POLL_ID)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('lists only files', async () => {
    stubFetch(respond([{ name: '.emptyFolderPlaceholder', id: 'p' }, { name: 'b-2.webp', id: 'y' }]));
    expect(await listStorageFolder(env, TOKEN, 'poll-images', POLL_ID)).toEqual([`${POLL_ID}/b-2.webp`]);
  });
});
