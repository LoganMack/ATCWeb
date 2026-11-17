import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/incidentReports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/incidentReports')>()),
  setRoundPosted: vi.fn(),
}));
vi.mock('../../src/lib/incidentPageHeader', () => ({ incidentReportBlocked: vi.fn() }));
vi.mock('../../src/lib/results/rounds', () => ({ getRoundBySubsessionId: vi.fn() }));
vi.mock('../../src/lib/activityLog', () => ({ logActivity: vi.fn() }));

import { setRoundPosted } from '../../src/lib/incidentReports';
import { incidentReportBlocked } from '../../src/lib/incidentPageHeader';
import { getRoundBySubsessionId } from '../../src/lib/results/rounds';
import { logActivity } from '../../src/lib/activityLog';
import { handlePostReport } from '../../src/lib/incidentActions/postReport';
import type { IncidentActionContext } from '../../src/lib/incidentActions/context';

const setRoundPostedMock = vi.mocked(setRoundPosted);
const blockedMock = vi.mocked(incidentReportBlocked);
const getRoundMock = vi.mocked(getRoundBySubsessionId);
const logActivityMock = vi.mocked(logActivity);

function context(search = '?season=s1&post=failed'): IncidentActionContext {
  return {
    supabaseEnv: { url: 'https://example.test', anonKey: 'anon' } as IncidentActionContext['supabaseEnv'],
    subsessionId: 123,
    shellPath: '/results/123/incidents',
    url: new URL(`https://site.test/results/123/incidents/fragment${search}`),
    session: undefined as unknown as IncidentActionContext['session'],
    accessToken: 'token-1',
    actor: { id: 'u1', name: 'Steward' },
    roundLabel: 'Sonoma',
    redirect: (location) => ({ location, status: 302 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getRoundMock.mockResolvedValue({
    track_name: 'Sonoma',
    start_time: '2026-11-16T19:00:00Z',
  } as Awaited<ReturnType<typeof getRoundBySubsessionId>>);
  blockedMock.mockResolvedValue(false);
  setRoundPostedMock.mockResolvedValue({ posted: true, reset: false, firstPost: true });
});

describe('handlePostReport', () => {
  it('posts with the session token and keeps the post date', async () => {
    await handlePostReport(context());
    expect(blockedMock).toHaveBeenCalledWith(expect.anything(), 123, '2026-11-16T19:00:00Z');
    expect(setRoundPostedMock).toHaveBeenCalledWith(expect.anything(), 'token-1', 123, {
      posted: true,
      resetDate: false,
    });
  });

  it('redirects to the page without the post flag and keeps the other params', async () => {
    const result = await handlePostReport(context());
    expect(result).toEqual({ location: '/results/123/incidents?season=s1', status: 302 });
  });

  it('refuses while incident submissions are open, without posting', async () => {
    blockedMock.mockResolvedValue(true);
    const result = await handlePostReport(context('?season=s1'));
    expect(result.location).toBe('/results/123/incidents?season=s1&post=open');
    expect(setRoundPostedMock).not.toHaveBeenCalled();
  });

  it('redirects with post=failed and logs nothing when posting fails', async () => {
    setRoundPostedMock.mockRejectedValue(new Error('Only an admin or staff member can post a round'));
    const result = await handlePostReport(context('?season=s1'));
    expect(result.location).toBe('/results/123/incidents?season=s1&post=failed');
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it('fails without posting when the round read fails or finds nothing', async () => {
    getRoundMock.mockRejectedValueOnce(new Error('network'));
    expect((await handlePostReport(context(''))).location).toBe('/results/123/incidents?post=failed');
    getRoundMock.mockResolvedValueOnce(null);
    expect((await handlePostReport(context(''))).location).toBe('/results/123/incidents?post=failed');
    expect(setRoundPostedMock).not.toHaveBeenCalled();
  });

  it('still reports success when the log write fails', async () => {
    logActivityMock.mockRejectedValueOnce(new Error('rls'));
    const result = await handlePostReport(context(''));
    expect(result.location).toBe('/results/123/incidents');
  });

  it('logs a first post and a re-post from firstPost', async () => {
    await handlePostReport(context(''));
    expect(logActivityMock.mock.calls[0][3]).toMatchObject({
      entity_type: 'incident_report',
      entity_label: 'Posted incident report — Sonoma',
      entity_id: '123',
    });

    setRoundPostedMock.mockResolvedValueOnce({ posted: true, reset: false, firstPost: false });
    await handlePostReport(context(''));
    expect(logActivityMock.mock.calls[1][3].entity_label).toBe(
      'Re-posted incident report (original post date kept) — Sonoma',
    );
  });
});
