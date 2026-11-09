/**
 * Close Appeal and steward comments (appeals unit U1): the database status codes and how they map to typed
 * outcomes, and the request each RPC sends. PostgREST is stubbed through fetch; nothing reaches Supabase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeIncidentAppeal,
  getAppealCommentsForSubsession,
  getIncidentAppealsForSubsession,
  saveIncidentAppealComment,
  toAppealCommentOutcome,
  toCloseAppealOutcome,
  type IncidentAppeal,
} from '../../src/lib/incidentAppeals';
import {
  appealCardView,
  closeAppealPrefill,
  parseAppealCommentBody,
  parseCloseAppealForm,
} from '../../src/lib/appealClose';
import { APPEAL_ACTION_FLASH_MESSAGES } from '../../src/lib/incidentActions/appealFlash';
import { toPenalties } from './penaltyFixtures';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const TOKEN = 'steward-token';
const APPEAL_ID = 'dddddddd-1111-4222-8333-444444444444';

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

// PostgREST returns a function's text result as a JSON string ("ok").
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const call: Call = {
        url: String(input),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
        auth: headers.get('Authorization'),
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

const decision = {
  timePenaltySeconds: 2.5,
  pointsPenalty: 1,
  penaltyPoints: 0,
  isWarning: false,
  comment: 'Reduced.',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the close and comment status codes', () => {
  it.each(['ok', 'already_closed', 'not_open', 'not_allowed', 'invalid'] as const)(
    'maps the close code %s',
    (code) => {
      expect(toCloseAppealOutcome(code)).toBe(code);
    },
  );

  it('tells the steward a dismissed appeal was not closed', () => {
    expect(APPEAL_ACTION_FLASH_MESSAGES.dismissed.message).toMatch(/dismissed/);
    expect(APPEAL_ACTION_FLASH_MESSAGES.dismissed.kind).toBe('error');
  });

  it.each(['ok', 'not_open', 'not_allowed', 'invalid'] as const)('maps the comment code %s', (code) => {
    expect(toAppealCommentOutcome(code)).toBe(code);
  });

  it('throws on a code the database never sends, so a changed function fails loudly', () => {
    expect(() => toCloseAppealOutcome('dismissed')).toThrow(/close_incident_appeal/);
    expect(() => toCloseAppealOutcome(null)).toThrow();
    expect(() => toAppealCommentOutcome('already_closed')).toThrow(/save_incident_appeal_comment/);
    expect(() => toAppealCommentOutcome(undefined)).toThrow();
  });
});

describe('closeIncidentAppeal', () => {
  it('calls close_incident_appeal as the steward with every decided value', async () => {
    const calls = stubFetch(() => respond('ok'));
    await expect(closeIncidentAppeal(env, TOKEN, APPEAL_ID, decision)).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://project.example.test/rest/v1/rpc/close_incident_appeal',
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: {
        p_appeal_id: APPEAL_ID,
        p_time: 2.5,
        p_points: 1,
        p_licence: 0,
        p_is_warning: false,
        p_comment: 'Reduced.',
      },
    });
  });

  it('returns already_closed when another steward closed it first', async () => {
    stubFetch(() => respond('already_closed'));
    await expect(closeIncidentAppeal(env, TOKEN, APPEAL_ID, decision)).resolves.toBe('already_closed');
  });

  it('throws on a transport error', async () => {
    stubFetch(() => respond({ message: 'boom' }, 500));
    await expect(closeIncidentAppeal(env, TOKEN, APPEAL_ID, decision)).rejects.toThrow(/500/);
  });
});

describe('saveIncidentAppealComment', () => {
  it('calls save_incident_appeal_comment as the steward', async () => {
    const calls = stubFetch(() => respond('ok'));
    await expect(saveIncidentAppealComment(env, TOKEN, APPEAL_ID, 'Uphold it')).resolves.toBe('ok');
    expect(calls[0]).toMatchObject({
      url: 'https://project.example.test/rest/v1/rpc/save_incident_appeal_comment',
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: { p_appeal_id: APPEAL_ID, p_body: 'Uphold it' },
    });
  });

  it('returns not_open for a closed or dismissed appeal', async () => {
    stubFetch(() => respond('not_open'));
    await expect(saveIncidentAppealComment(env, TOKEN, APPEAL_ID, 'Late')).resolves.toBe('not_open');
  });
});

describe('the appeal reads', () => {
  it('reads the round comments through incident_appeal_comments_for_round', async () => {
    const rows = [
      {
        appeal_id: APPEAL_ID,
        author_name: 'Steward Two',
        body: 'Reduce',
        updated_at: '2026-11-09T12:00:00Z',
        is_mine: false,
      },
    ];
    const calls = stubFetch(() => respond(rows));
    await expect(getAppealCommentsForSubsession(env, TOKEN, 9001)).resolves.toEqual(rows);
    expect(calls[0]).toMatchObject({
      url: 'https://project.example.test/rest/v1/rpc/incident_appeal_comments_for_round',
      auth: `Bearer ${TOKEN}`,
      body: { p_subsession_id: 9001 },
    });
  });

  it('embeds the closing steward with the appeals (BR5.1)', async () => {
    const calls = stubFetch(() => respond([]));
    await getIncidentAppealsForSubsession(env, TOKEN, 9001);
    expect(calls[0].url).toContain('closer:profiles!incident_appeals_closed_by_fkey(display_name)');
    expect(calls[0].url).toContain('subsession_id=eq.9001');
  });
});

function closeForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  const all = {
    appeal_id: APPEAL_ID,
    time_penalty_seconds: '5',
    points_penalty: '2',
    penalty_points: '3',
    comment: 'Upheld.',
    ...fields,
  };
  for (const [k, v] of Object.entries(all)) form.set(k, v);
  return form;
}

describe('closeAppealPrefill (BR3.1)', () => {
  it('opens with the effective values, a missing time shown as 0', () => {
    const [plain] = toPenalties([{ driver_id: 'A', points_penalty: 2, penalty_points: 3, is_warning: true }]);
    expect(closeAppealPrefill(plain)).toEqual({
      timePenaltySeconds: 0,
      pointsPenalty: 2,
      penaltyPoints: 3,
      isWarning: true,
    });
  });

  it('opens with the earlier close values on a second appeal (BR3.4)', () => {
    const [appealed] = toPenalties([
      {
        driver_id: 'A',
        time_penalty_seconds: 10,
        penalty_points: 3,
        is_warning: true,
        is_appealed: true,
        appeal_time_penalty_seconds: 2.5,
        appeal_penalty_points: 1,
        appeal_is_warning: false,
      },
    ]);
    expect(closeAppealPrefill(appealed)).toEqual({
      timePenaltySeconds: 2.5,
      pointsPenalty: 0,
      penaltyPoints: 1,
      isWarning: false,
    });
  });
});

describe('parseCloseAppealForm (BR3.1)', () => {
  it('reads a valid decision, trimming the comment and reading the warning tick', () => {
    expect(
      parseCloseAppealForm(
        closeForm({ time_penalty_seconds: '2.125', is_warning: 'on', comment: '  Reduced.  ' }),
      ),
    ).toEqual({
      ok: true,
      appealId: APPEAL_ID,
      input: {
        timePenaltySeconds: 2.125,
        pointsPenalty: 2,
        penaltyPoints: 3,
        isWarning: true,
        comment: 'Reduced.',
      },
    });
  });

  it('takes 0 everywhere and no tick as no warning', () => {
    const parsed = parseCloseAppealForm(
      closeForm({ time_penalty_seconds: '0', points_penalty: '0', penalty_points: '0' }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      input: { timePenaltySeconds: 0, pointsPenalty: 0, penaltyPoints: 0, isWarning: false },
    });
  });

  it.each([
    ['a negative time', { time_penalty_seconds: '-1' }, /time penalty/],
    ['four decimals', { time_penalty_seconds: '1.2345' }, /3 decimals/],
    ['a blank time', { time_penalty_seconds: '' }, /time penalty/],
    ['a word for time', { time_penalty_seconds: 'five' }, /time penalty/],
    ['fractional points', { points_penalty: '1.5' }, /points penalty/],
    ['negative points', { points_penalty: '-2' }, /points penalty/],
    ['negative licence points', { penalty_points: '-1' }, /Penalty points/],
    ['licence points past the column', { penalty_points: '9999999999' }, /Penalty points/],
    ['a blank comment', { comment: '   ' }, /comment/],
    ['a comment over 4,000 characters', { comment: 'a'.repeat(4001) }, /4000/],
    ['a bad appeal id', { appeal_id: 'nope' }, /could not be found/],
  ])('refuses %s', (_, fields, message) => {
    const parsed = parseCloseAppealForm(closeForm(fields));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(message);
  });

  it('counts characters as the database does, so 4,000 emoji still fit', () => {
    expect(parseCloseAppealForm(closeForm({ comment: '\u{1F3C1}'.repeat(4000) })).ok).toBe(true);
  });
});

describe('parseAppealCommentBody (BR2.2)', () => {
  const form = (body: string) => {
    const f = new FormData();
    f.set('body', body);
    return f;
  };

  it('trims and accepts 1 to 4,000 characters', () => {
    expect(parseAppealCommentBody(form('  Uphold  '))).toEqual({ ok: true, body: 'Uphold' });
    expect(parseAppealCommentBody(form('b'.repeat(4000))).ok).toBe(true);
  });

  it('refuses a blank or too-long comment', () => {
    expect(parseAppealCommentBody(form('  ')).ok).toBe(false);
    expect(parseAppealCommentBody(form('b'.repeat(4001))).ok).toBe(false);
  });
});

const appeal = (overrides: Partial<IncidentAppeal> = {}): IncidentAppeal => ({
  id: APPEAL_ID,
  subsession_id: 9001,
  penalty_id: 'cccccccc-1111-4222-8333-444444444444',
  message: 'Not my fault',
  files: [],
  submitter_id: null,
  submitter_name: null,
  status: 'open',
  created_at: '2026-11-08T12:00:00Z',
  closed_at: null,
  closed_by: null,
  close_comment: null,
  decided_time_penalty_seconds: null,
  decided_points_penalty: null,
  decided_penalty_points: null,
  decided_is_warning: null,
  closer: null,
  ...overrides,
});

const closed = (overrides: Partial<IncidentAppeal> = {}) =>
  appeal({
    status: 'reviewed',
    closed_at: '2026-11-09T15:30:00Z',
    closed_by: 'eeeeeeee-1111-4222-8333-444444444444',
    close_comment: 'Reduced to a reprimand.',
    decided_time_penalty_seconds: 2.5,
    decided_points_penalty: 1,
    decided_penalty_points: 0,
    decided_is_warning: false,
    closer: { display_name: 'Steward Out' },
    ...overrides,
  });

describe('appealCardView (BR1.2, BR1.3, BR5.1)', () => {
  it('offers View Decision, Dismiss, Close Appeal and Add Comment on an open appeal', () => {
    expect(appealCardView(appeal(), false)).toEqual({
      badge: 'Open',
      viewDecision: true,
      dismiss: true,
      closeAppeal: true,
      commentLabel: 'Add Comment',
      reopen: false,
      outcome: null,
    });
  });

  it('says Edit Comment once the steward has one', () => {
    expect(appealCardView(appeal(), true).commentLabel).toBe('Edit Comment');
  });

  it('offers only View Decision to an involved steward', () => {
    expect(appealCardView(appeal(), true, true)).toMatchObject({
      viewDecision: true,
      dismiss: false,
      closeAppeal: false,
      commentLabel: null,
      reopen: false,
    });
    expect(appealCardView(appeal({ status: 'dismissed' }), false, true).reopen).toBe(false);
  });

  it('offers only Reopen on a dismissed appeal', () => {
    expect(appealCardView(appeal({ status: 'dismissed' }), true)).toEqual({
      badge: 'Dismissed',
      viewDecision: false,
      dismiss: false,
      closeAppeal: false,
      commentLabel: null,
      reopen: true,
      outcome: null,
    });
  });

  it('shows a closed appeal its own decision, comment and closer, with no buttons', () => {
    const view = appealCardView(closed(), true);
    expect(view).toMatchObject({
      badge: 'Closed',
      viewDecision: false,
      dismiss: false,
      closeAppeal: false,
      commentLabel: null,
      reopen: false,
    });
    expect(view.outcome).toEqual({
      lines: ['Time penalty: 2.5 s', 'Points penalty: 1', 'Penalty points: 0', 'Warning: No'],
      comment: 'Reduced to a reprimand.',
      closedBy: 'Steward Out',
      closedAt: '2026-11-09T15:30:00Z',
    });
  });

  it('names a deleted steward "a former steward"', () => {
    expect(appealCardView(closed({ closed_by: null, closer: null }), false).outcome?.closedBy).toBe(
      'a former steward',
    );
  });

  it('shows only the Closed badge for an appeal reviewed before Close Appeal existed', () => {
    expect(appealCardView(appeal({ status: 'reviewed' }), false)).toMatchObject({
      badge: 'Closed',
      outcome: null,
      reopen: false,
    });
  });
});
