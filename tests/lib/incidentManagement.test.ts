/**
 * Incident management on the own profile (U5 incident-management): the tab's row states and labels
 * (BR11.4-BR11.13), the points difference against effectivePenaltyPoints (BR11.11), the database error codes,
 * the shared appeal core with its pre-check before any upload (BR11.9, NFR4.1), the round page's code mapping,
 * the profile intents in JSON and redirect form (BR11.14, NFR1.7), the load failure (NFR4.2) and logs that
 * carry codes and ids only (NFR9.1). PostgREST and Storage are stubbed through fetch; the clock is fixed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIncidentManagementRow,
  buildIncidentManagementView,
  incidentSessionLabel,
  loadIncidentPanel,
  addMyIncidentComment,
  MY_INCIDENTS_LIMIT,
  type MyIncidentDbRow,
} from '../../src/lib/incidents';
import { parseDbErrorCode } from '../../src/lib/incidentErrors';
import { effectivePenaltyPoints, type PenaltyLike } from '../../src/lib/penalties/effective';
import {
  appealOutcomeMessage,
  handleSubmitAppeal,
  submitAppealCore,
} from '../../src/lib/incidentActions/submitAppeal';
import { incidentStatusMessage } from '../../src/lib/incidentActions/profileIncidents';
import { handleProfilePost, type ProfilePostContext } from '../../src/lib/driverAccount';
import { incidentSummariesJson } from '../../src/lib/incidentDisplay';
import type { IncidentRow } from '../../src/lib/incidents';
import { appealProblem, commentProblem, rowUpdateFor } from '../../src/scripts/incidentManagement';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const USER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DRIVER_ID = '11111111-2222-4333-8444-555555555555';
const PENALTY_ID = 'cccccccc-1111-4222-8333-444444444444';
const REPORT_ID = 'dddddddd-1111-4222-8333-444444444444';
const TOKEN = 'user-token';
const session = { accessToken: TOKEN, user: { id: USER_ID, email: 'ana@example.test', newEmail: null } };
const NOW = new Date('2026-10-24T12:00:00Z');
const SECRET_TEXT = 'My <script>alert("x")</script> side of "it"';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

// PostgREST returns a function's text result as a JSON string ("ok"), so every body is JSON.
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = { url: String(input), method: init.method ?? 'GET', body: init.body };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function captureLogs(): () => string {
  const spies = (['error', 'warn', 'info'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join(' ');
}

const pgError = (code: string, message: string) =>
  respond({ code: 'P0001', message: `${code}: ${message}` }, 400);

function dbRow(overrides: Partial<MyIncidentDbRow> = {}): MyIncidentDbRow {
  return {
    kind: 'posted_penalty',
    id: PENALTY_ID,
    subsession_id: 9001,
    round_label: 'ATC 18 · Round 3 · Spa',
    occurred_at: '2026-10-20T18:00:00Z',
    session: 'race',
    lap: 5,
    turn: null,
    description: null,
    penalized_car: '12',
    involved_cars: ['4', '33'],
    i_am_penalized: true,
    my_comment_exists: false,
    appeal_window_closes_at: '2026-10-25T00:00:00Z',
    my_appeal_status: 'none',
    points_before: 3,
    points_after: 3,
    time_or_points_changed: false,
    ...overrides,
  };
}

const pendingRow = (overrides: Partial<MyIncidentDbRow> = {}) =>
  dbRow({
    kind: 'pending_report',
    id: REPORT_ID,
    session: 'race:2',
    turn: '10b',
    description: SECRET_TEXT,
    penalized_car: null,
    i_am_penalized: false,
    appeal_window_closes_at: null,
    points_before: null,
    points_after: null,
    ...overrides,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Incident Management rows (BR11.4-BR11.13)', () => {
  it('shows a pending report as "Pending" with Add Comment until the comment exists', () => {
    const open = buildIncidentManagementRow(pendingRow(), NOW);
    expect(open).toMatchObject({
      kind: 'pending',
      state: 'pending',
      penalizedLabel: 'Pending',
      involvedLabel: '#4, #33',
      sessionLabel: 'Race 2',
      canComment: true,
      canAppeal: false,
      canViewIncident: false,
      statusLabel: 'Pending',
      description: SECRET_TEXT,
    });
    const sent = buildIncidentManagementRow(pendingRow({ my_comment_exists: true }), NOW);
    expect(sent).toMatchObject({ canComment: false, commentSent: true, statusLabel: 'Comment sent' });
  });

  it('offers View Incident and Submit Appeal while the window is open, and no appeal once it closes', () => {
    const posted = buildIncidentManagementRow(dbRow(), NOW);
    expect(posted).toMatchObject({
      state: 'posted',
      penalizedLabel: '#12',
      canViewIncident: true,
      canAppeal: true,
      appealSubmitted: false,
      statusLabel: 'Appeal open',
    });
    // The fake clock just after the window: the boundary instant counts as closed, as in isAppealOpen.
    expect(buildIncidentManagementRow(dbRow(), new Date('2026-10-25T00:00:00Z')).canAppeal).toBe(false);
    expect(buildIncidentManagementRow(dbRow({ appeal_window_closes_at: null }), NOW).canAppeal).toBe(false);
  });

  it('marks my open appeal as "Appeal Submitted" with no appeal button', () => {
    expect(buildIncidentManagementRow(dbRow({ my_appeal_status: 'open' }), NOW)).toMatchObject({
      state: 'appealed',
      canAppeal: false,
      appealSubmitted: true,
      canViewIncident: true,
      statusLabel: 'Appeal Submitted',
    });
  });

  it('shows a reviewed or dismissed appeal with the PP difference, "No change", or "Reviewed"', () => {
    const label = (o: Partial<MyIncidentDbRow>) =>
      buildIncidentManagementRow(dbRow({ my_appeal_status: 'reviewed', ...o }), NOW);
    expect(label({ points_after: 1 })).toMatchObject({
      state: 'reviewed',
      resultLabel: '-2 PP',
      canAppeal: false,
    });
    expect(label({ my_appeal_status: 'dismissed' }).resultLabel).toBe('No change');
    expect(label({ time_or_points_changed: true }).resultLabel).toBe('No change (time or points changed)');
    expect(label({ points_after: 5 }).resultLabel).toBe('+2 PP');
    // An involved driver's row carries no number (BR11.11 amended).
    expect(label({ i_am_penalized: false, points_after: 1 }).resultLabel).toBe('Reviewed');
    expect(label({}).statusLabel).toBe('No change');
  });

  it('leaves a racing incident’s penalized column blank and shows "—" with nobody else involved', () => {
    const row = buildIncidentManagementRow(dbRow({ penalized_car: null, involved_cars: [] }), NOW);
    expect(row.penalizedLabel).toBe('');
    expect(row.involvedLabel).toBe('—');
    expect(buildIncidentManagementRow(dbRow({ involved_cars: null }), NOW).involvedLabel).toBe('—');
  });

  it('gives every state a text label (BR11.12) and flags the 200-row cap (NFR3.4)', () => {
    const rows = [
      pendingRow(),
      dbRow(),
      dbRow({ my_appeal_status: 'open' }),
      dbRow({ my_appeal_status: 'reviewed' }),
    ];
    for (const row of buildIncidentManagementView(rows, NOW).rows) expect(row.statusLabel).not.toBe('');
    expect(buildIncidentManagementView(rows, NOW).capped).toBe(false);
    expect(
      buildIncidentManagementView(
        Array.from({ length: MY_INCIDENTS_LIMIT }, () => dbRow()),
        NOW,
      ).capped,
    ).toBe(true);
    expect(buildIncidentManagementView([], NOW).rows).toEqual([]);
  });

  it('names report sessions and penalty session types', () => {
    expect(incidentSessionLabel('race:1')).toBe('Race 1');
    expect(incidentSessionLabel('qualifying:0')).toBe('Qualifying');
    expect(incidentSessionLabel('practice')).toBe('Practice');
    expect(incidentSessionLabel(null)).toBe('—');
  });
});

describe('the points difference matches effectivePenaltyPoints (BR11.11)', () => {
  // my_incidents() returns points_before = penalty_points and points_after = the same formula as the helper.
  const sqlPoints = (p: PenaltyLike) => ({
    points_before: p.penalty_points,
    points_after: p.is_appealed ? p.appeal_penalty_points : p.penalty_points,
    time_or_points_changed:
      p.is_appealed &&
      ((p.appeal_time_penalty_seconds ?? 0) !== (p.time_penalty_seconds ?? 0) ||
        p.appeal_points_penalty !== p.points_penalty),
  });
  const base: PenaltyLike = {
    time_penalty_seconds: 5,
    points_penalty: 0,
    penalty_points: 3,
    is_appealed: false,
    appeal_time_penalty_seconds: null,
    appeal_points_penalty: 0,
    appeal_penalty_points: 0,
  };
  const cases: [string, PenaltyLike, string][] = [
    [
      'reduced',
      { ...base, is_appealed: true, appeal_penalty_points: 1, appeal_time_penalty_seconds: 5 },
      '-2 PP',
    ],
    [
      'removed',
      { ...base, is_appealed: true, appeal_penalty_points: 0, appeal_time_penalty_seconds: 5 },
      '-3 PP',
    ],
    [
      'unchanged',
      { ...base, is_appealed: true, appeal_penalty_points: 3, appeal_time_penalty_seconds: 5 },
      'No change',
    ],
    ['not appealed', base, 'No change'],
    [
      'time only',
      { ...base, is_appealed: true, appeal_penalty_points: 3, appeal_time_penalty_seconds: null },
      'No change (time or points changed)',
    ],
  ];

  for (const [name, penalty, expected] of cases) {
    it(`agrees for a ${name} penalty`, () => {
      const row = dbRow({ my_appeal_status: 'reviewed', ...sqlPoints(penalty) });
      expect(row.points_after).toBe(effectivePenaltyPoints(penalty));
      expect(buildIncidentManagementRow(row, NOW).resultLabel).toBe(expected);
    });
  }
});

describe('database error codes', () => {
  it('reads the code from a PostgREST body, an Error carrying one, or the bare message', () => {
    expect(parseDbErrorCode({ code: 'P0001', message: 'ALREADY_APPEALED: you have already appealed' })).toBe(
      'ALREADY_APPEALED',
    );
    expect(
      parseDbErrorCode(
        new Error(
          'Supabase rpc error 400 on submit_incident_appeal: {"code":"P0001","message":"NOT_INVOLVED: no"}',
        ),
      ),
    ).toBe('NOT_INVOLVED');
    expect(parseDbErrorCode('CLOSED: the appeal window for this round is closed')).toBe('CLOSED');
    expect(parseDbErrorCode('{"message":"ALREADY_COMMENTED: you have already commented"}')).toBe(
      'ALREADY_COMMENTED',
    );
  });

  it('returns null for unknown codes, uncoded messages and non-errors', () => {
    expect(parseDbErrorCode('RATE_LIMITED: slow down')).toBeNull();
    expect(parseDbErrorCode(new Error('too many appeals for this round'))).toBeNull();
    expect(parseDbErrorCode(null)).toBeNull();
    expect(parseDbErrorCode(new Error('fetch failed {not json'))).toBeNull();
  });
});

describe('the shared appeal core (BR11.9, NFR4.1)', () => {
  const isPreCheck = (c: Call) => c.url.endsWith('/rest/v1/rpc/can_appeal_penalty');
  const isUpload = (c: Call) => c.url.includes('/storage/v1/object/incident-appeals/');
  const isAppeal = (c: Call) => c.url.endsWith('/rest/v1/rpc/submit_incident_appeal');
  const file = () => new File([new Uint8Array([1, 2, 3])], 'onboard.png', { type: 'image/png' });
  const input = (files: File[] = [file()]) => ({ penaltyId: PENALTY_ID, message: SECRET_TEXT, files });

  it('asks can_appeal_penalty first and uploads nothing when it refuses', async () => {
    const logs = captureLogs();
    for (const [answer, outcome] of [
      ['NOT_INVOLVED', 'notinvolved'],
      ['ALREADY_APPEALED', 'already'],
      ['CLOSED', 'closed'],
      ['UNKNOWN', 'unknown'],
    ] as const) {
      const calls = stubFetch(() => respond(answer));
      expect(await submitAppealCore(env, session, input())).toBe(outcome);
      expect(calls.map((c) => c.url)).toEqual([`${env.url}/rest/v1/rpc/can_appeal_penalty`]);
      expect(JSON.parse(calls[0].body as string)).toEqual({ p_penalty_id: PENALTY_ID });
    }
    expect(logs()).not.toContain('script');
    expect(logs()).toContain(PENALTY_ID);
  });

  it('uploads into the user’s folder and records the appeal after an ok pre-check', async () => {
    const calls = stubFetch((c) => (isPreCheck(c) ? respond('ok') : respond(isAppeal(c) ? 'id' : {})));
    expect(await submitAppealCore(env, session, input())).toBe('ok');
    expect(
      calls.map((c) => (isPreCheck(c) ? 'check' : isUpload(c) ? 'upload' : isAppeal(c) ? 'appeal' : c.url)),
    ).toEqual(['check', 'upload', 'appeal']);
    expect(calls[1].url).toContain(`/incident-appeals/${USER_ID}/`);
    const body = JSON.parse(calls[2].body as string);
    expect(body).toMatchObject({ p_penalty_id: PENALTY_ID, p_message: SECRET_TEXT });
    expect(body.p_files[0].path).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}/1-onboard\\.png$`));
  });

  it('maps a database refusal at insert time (a race with another tab) and a failure to codes', async () => {
    const logs = captureLogs();
    stubFetch((c) =>
      isPreCheck(c) ? respond('ok') : isAppeal(c) ? pgError('ALREADY_APPEALED', 'again') : respond({}),
    );
    expect(await submitAppealCore(env, session, input([]))).toBe('already');
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await submitAppealCore(env, session, input([]))).toBe('failed');
    expect(logs()).toContain('submit-appeal failed');
    expect(logs()).not.toContain(SECRET_TEXT);
  });

  it('refuses bad input before any request', async () => {
    const calls = stubFetch(() => respond('ok'));
    expect(await submitAppealCore(env, session, { ...input(), message: '' })).toBe('invalid');
    expect(await submitAppealCore(env, session, input([file(), file(), file(), file()]))).toBe('toomany');
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    expect(await submitAppealCore(env, session, input([big]))).toBe('toolarge');
    const exe = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' });
    expect(await submitAppealCore(env, session, input([exe]))).toBe('badtype');
    expect(calls).toHaveLength(0);
  });
});

describe('the round page’s appeal codes (BR11.9 amended)', () => {
  function roundContext() {
    const url = new URL('https://atc.example.test/results/9001/incidents/fragment');
    return {
      supabaseEnv: env,
      subsessionId: 9001,
      shellPath: '/results/9001/incidents',
      url,
      session: session as unknown as App.Locals['session'],
      redirect: (location: string) => ({ location, status: 302 as const }),
    };
  }
  const form = () => {
    const f = new FormData();
    f.set('intent', 'submit-appeal');
    f.set('penalty_id', PENALTY_ID);
    f.set('message', 'Please look again');
    return f;
  };
  function roundFetch(preCheck: string) {
    return stubFetch((c) => {
      if (c.url.includes('round_incident_status'))
        return respond([{ posted: true, posted_at: new Date().toISOString() }]);
      if (c.url.includes('site_settings')) return respond([]);
      if (c.url.includes('penalties_shown')) return respond([{ id: PENALTY_ID }]);
      if (c.url.endsWith('/rpc/can_appeal_penalty')) return respond(preCheck);
      return respond('id');
    });
  }

  it('redirects with notinvolved and already, and shows their messages', async () => {
    captureLogs();
    roundFetch('NOT_INVOLVED');
    expect((await handleSubmitAppeal(roundContext(), form())).location).toBe(
      '/results/9001/incidents?appeal=notinvolved',
    );
    roundFetch('ALREADY_APPEALED');
    expect((await handleSubmitAppeal(roundContext(), form())).location).toBe(
      '/results/9001/incidents?appeal=already',
    );
    expect(appealOutcomeMessage('notinvolved')).toBe("You're not involved in this incident.");
    expect(appealOutcomeMessage('already')).toBe("You've already appealed this incident.");
  });

  it('still says ok for an allowed appeal and signin when signed out', async () => {
    const calls = roundFetch('ok');
    expect((await handleSubmitAppeal(roundContext(), form())).location).toBe(
      '/results/9001/incidents?appeal=ok',
    );
    expect(calls.some((c) => c.url.endsWith('/rpc/submit_incident_appeal'))).toBe(true);
    const signedOut = { ...roundContext(), session: null as unknown as App.Locals['session'] };
    expect((await handleSubmitAppeal(signedOut, form())).location).toBe(
      '/results/9001/incidents?appeal=signin',
    );
  });
});

describe('the profile intents (BR11.14, NFR1.7, C4)', () => {
  function context(
    fields: Record<string, string>,
    overrides: Partial<ProfilePostContext> = {},
  ): ProfilePostContext {
    const form = new FormData();
    form.append('intent', 'save-profile');
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return {
      env,
      session,
      isOwner: true,
      driverId: DRIVER_ID,
      origin: 'https://atc.example.test',
      json: true,
      form,
      ...overrides,
    };
  }
  const comment = { intent: 'add-incident-comment', report_id: REPORT_ID, body: SECRET_TEXT };

  it('adds a comment in place and answers with the updated row', async () => {
    const calls = stubFetch(() => respond('new-id'));
    const outcome = await handleProfilePost(context(comment));
    expect(outcome).toMatchObject({
      kind: 'json',
      status: 200,
      body: { ok: true, data: { id: REPORT_ID, state: 'pending', commentSent: true } },
    });
    expect(calls[0].url).toBe(`${env.url}/rest/v1/rpc/add_my_incident_comment`);
    expect(JSON.parse(calls[0].body as string)).toEqual({ p_report_id: REPORT_ID, p_body: SECRET_TEXT });
  });

  it('maps each comment refusal to its message and logs the code and id only', async () => {
    const logs = captureLogs();
    for (const [code, message] of [
      ['ALREADY_COMMENTED', "You've already commented."],
      ['NOT_INVOLVED', "You're not involved in this incident."],
      ['CLOSED', 'This incident is no longer open for comments.'],
    ]) {
      stubFetch(() => pgError(code, 'refused'));
      expect(await handleProfilePost(context(comment))).toMatchObject({
        kind: 'json',
        status: 409,
        body: { ok: false, message },
      });
    }
    expect(logs()).toContain('add-incident-comment failed');
    expect(logs()).toContain(REPORT_ID);
    expect(logs()).not.toContain('script');
  });

  it('refuses an empty comment without calling the database', async () => {
    captureLogs();
    const calls = stubFetch(() => respond('id'));
    expect(await handleProfilePost(context({ ...comment, body: '   ' }))).toMatchObject({
      kind: 'json',
      status: 400,
      body: { ok: false },
    });
    expect(calls).toHaveLength(0);
  });

  it('redirects without JavaScript to the incidents tab with a code-only status', async () => {
    stubFetch(() => respond('id'));
    expect(await handleProfilePost(context(comment, { json: false }))).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}?edit=1&tab=incidents&incident_status=comment_sent`,
    });
    expect(incidentStatusMessage('comment_sent')).toEqual({
      ok: true,
      message: expect.stringContaining('Comment sent'),
    });
    expect(incidentStatusMessage('appeal_already')?.message).toBe("You've already appealed this incident.");
    expect(incidentStatusMessage('appeal_<script>')).toBeNull();
    expect(incidentStatusMessage(null)).toBeNull();
  });

  it('appeals from the profile: resolves the round, pre-checks, and answers C4', async () => {
    captureLogs();
    const calls = stubFetch((c) => {
      if (c.url.includes('penalties_shown')) return respond([{ subsession_id: 9001 }]);
      if (c.url.endsWith('/rpc/can_appeal_penalty')) return respond('NOT_INVOLVED');
      return respond('id');
    });
    const appeal = { intent: 'submit-appeal-from-profile', penalty_id: PENALTY_ID, message: 'Look again' };
    expect(await handleProfilePost(context(appeal))).toMatchObject({
      kind: 'json',
      status: 409,
      body: { ok: false, message: "You're not involved in this incident." },
    });
    expect(calls.some((c) => c.url.includes('/storage/'))).toBe(false);

    stubFetch((c) => {
      if (c.url.includes('penalties_shown')) return respond([{ subsession_id: 9001 }]);
      if (c.url.endsWith('/rpc/can_appeal_penalty')) return respond('ok');
      return respond('id');
    });
    expect(await handleProfilePost(context(appeal))).toMatchObject({
      kind: 'json',
      status: 200,
      body: { ok: true, data: { id: PENALTY_ID, state: 'appealed' } },
    });

    // A penalty the viewer can't see (unposted or unknown) is refused before the pre-check.
    const hidden = stubFetch((c) => (c.url.includes('penalties_shown') ? respond([]) : respond('ok')));
    expect(await handleProfilePost(context(appeal))).toMatchObject({
      kind: 'json',
      status: 400,
      body: { ok: false },
    });
    expect(hidden).toHaveLength(1);
  });

  it('refuses the intents for anyone but the owner, writing nothing', async () => {
    const calls = stubFetch(() => respond('id'));
    expect(await handleProfilePost(context(comment, { isOwner: false }))).toMatchObject({
      kind: 'json',
      status: 403,
      body: { ok: false },
    });
    expect(await handleProfilePost(context(comment, { isOwner: false, json: false }))).toEqual({
      kind: 'redirect',
      location: `/drivers/${DRIVER_ID}`,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('the popups’ browser checks (src/scripts/incidentManagement.ts)', () => {
  const limits = { maxFiles: 3, maxFileBytes: 5 * 1024 * 1024, maxFileMb: 5 };

  it('checks the comment and the appeal before posting', () => {
    expect(commentProblem('  ', 2000)).toBe('Write your comment first.');
    expect(commentProblem('x'.repeat(2001), 2000)).toBe('Your comment can be at most 2,000 characters.');
    expect(commentProblem(SECRET_TEXT, 2000)).toBeNull();
    expect(appealProblem('', [], limits)).toBe('Your appeal needs a written explanation.');
    expect(appealProblem('Why', [{ size: 1 }, { size: 1 }, { size: 1 }, { size: 1 }], limits)).toBe(
      'You can attach up to 3 files.',
    );
    expect(appealProblem('Why', [{ size: limits.maxFileBytes + 1 }], limits)).toBe(
      'Each file must be 5 MB or smaller.',
    );
    expect(appealProblem('Why', [{ size: 10 }], limits)).toBeNull();
  });

  it('updates a row only after a successful action', () => {
    expect(rowUpdateFor('add-incident-comment', { ok: true, message: 'Sent' })).toEqual({ kind: 'comment' });
    expect(rowUpdateFor('submit-appeal-from-profile', { ok: true, message: 'Sent' })).toEqual({
      kind: 'appeal',
    });
    expect(rowUpdateFor('submit-appeal-from-profile', { ok: false, message: 'No' })).toBeNull();
    expect(rowUpdateFor('change-email', { ok: true, message: 'Sent' })).toBeNull();
  });
});

describe('reads and failures', () => {
  it('calls my_incidents and add_my_incident_comment with the user’s token', async () => {
    const calls = stubFetch(() => respond('id'));
    expect(await addMyIncidentComment(env, TOKEN, REPORT_ID, 'Hi')).toEqual({ ok: true });
    expect((calls[0] as unknown as { url: string }).url).toContain('/rpc/add_my_incident_comment');
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await addMyIncidentComment(env, TOKEN, REPORT_ID, 'Hi')).toEqual({ ok: false, code: 'UNKNOWN' });
  });

  it('turns a failed tab load into the tab’s error state, logging only the status (NFR4.2, NFR9.1)', async () => {
    const logs = captureLogs();
    stubFetch(() => respond({ message: `boom ${SECRET_TEXT}` }, 503));
    expect(await loadIncidentPanel(env, TOKEN, DRIVER_ID)).toEqual({ view: null, detailRows: [] });
    expect(logs()).toContain('incident-management load failed 503');
    expect(logs()).not.toContain('script');
  });

  it('escapes "<" in the View Incident JSON block, so a description cannot close the script tag (NFR1.8)', () => {
    const row = {
      id: PENALTY_ID,
      description: SECRET_TEXT,
      involvedDrivers: [],
      offenseNames: [],
    } as unknown as IncidentRow;
    const json = incidentSummariesJson([
      { ...row, driver: null, startTime: '2026-10-20T18:00:00Z' } as IncidentRow,
    ]);
    expect(json).not.toContain('<script>');
    expect(json).toContain('\\u003cscript>');
    expect(JSON.parse(json)[PENALTY_ID].description).toBe(SECRET_TEXT);
  });
});
