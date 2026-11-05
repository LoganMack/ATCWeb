/**
 * The admin dashboard's latest-event card (FR5.3-FR5.5; BR5.3-BR5.10): wording, windows, the summary and
 * the loader's reads and fallbacks. Every case uses a fixed `now`; the loader runs against a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appealWindowText,
  countLabel,
  formatTimeLeft,
  getLatestEventSummary,
  latestEventLabel,
  submissionWindowText,
  summariseLatestEvent,
  type LatestEventInputs,
  type LatestRound,
} from '../../src/lib/adminLatestEvent';

const NOW = new Date('2026-11-05T12:00:00Z');
const HOUR = 3_600_000;
const MIN = 60_000;

const ROUND: LatestRound = {
  subsession_id: 8001,
  season_id: 'season-18',
  season_label: 'ATC18',
  start_time: '2026-11-04T18:00:00Z',
  track_name: 'Sonoma Raceway',
  event_id: null,
};

function inputs(over: Partial<LatestEventInputs> = {}): LatestEventInputs {
  return {
    round: ROUND,
    displayNumber: 8,
    posting: null,
    reportStatuses: [],
    appealStatuses: [],
    reportingWindow: {
      raceOverUtc: new Date(NOW.getTime() - HOUR),
      closesUtc: new Date(NOW.getTime() + 5 * HOUR),
    },
    appealPeriodHours: 24,
    now: NOW,
    ...over,
  };
}

function text(over: Partial<LatestEventInputs> = {}) {
  const s = summariseLatestEvent(inputs(over));
  return {
    submissions: submissionWindowText(s.submissionWindow, s.submissionClosesAt, NOW),
    appeals: appealWindowText(s.appealWindow, s.appealClosesAt, NOW),
    summary: s,
  };
}

describe('latest-event wording (BR5.5, BR5.6, BR5.9)', () => {
  it('formats time left in days and hours from a day, else hours and minutes rounded up', () => {
    expect(formatTimeLeft(2 * 24 * HOUR + 3 * HOUR + 10 * MIN)).toBe('2 d 3 h');
    expect(formatTimeLeft(24 * HOUR)).toBe('1 d 0 h');
    expect(formatTimeLeft(5 * HOUR + 12 * MIN)).toBe('5 h 12 m');
    expect(formatTimeLeft(5 * HOUR)).toBe('5 h 0 m');
    expect(formatTimeLeft(5 * HOUR - 30_000)).toBe('5 h 0 m');
    expect(formatTimeLeft(12 * MIN)).toBe('12 m');
    expect(formatTimeLeft(1)).toBe('1 m');
  });

  it('words the counts with singular for exactly one', () => {
    expect(countLabel(7, 2, 'submission')).toBe('7 submissions (2 open)');
    expect(countLabel(1, 1, 'appeal')).toBe('1 appeal (1 open)');
    expect(countLabel(0, 0, 'appeal')).toBe('0 appeals (0 open)');
  });

  it('labels the round with season, display number or Exhibition, and track (BR5.4)', () => {
    expect(latestEventLabel(ROUND, 8)).toBe('ATC18, Round 8: Sonoma Raceway');
    expect(latestEventLabel(ROUND, null)).toBe('ATC18, Exhibition: Sonoma Raceway');
  });
});

describe('latest-event windows (BR5.7, BR5.8)', () => {
  it('shows the submission window as open, closed after the close time, closed once posted, or unknown', () => {
    expect(text().submissions).toBe('Closes in 5 h 0 m');
    const past = {
      raceOverUtc: new Date(NOW.getTime() - 30 * HOUR),
      closesUtc: new Date(NOW.getTime() - HOUR),
    };
    expect(text({ reportingWindow: past }).submissions).toBe('Closed');
    expect(text({ posting: { posted: true, posted_at: NOW.toISOString() } }).submissions).toBe('Closed');
    expect(text({ reportingWindow: null }).submissions).toBe('Unknown');
    expect(text({ reportingWindow: null }).summary.submissionWindow).toBe('unknown');
  });

  it('shows the appeal window as not posted, open, closed, or closed when posted with no post time', () => {
    expect(text().appeals).toBe('Opens when posted');
    expect(text({ posting: { posted: false, posted_at: '2026-11-04T12:00:00Z' } }).appeals).toBe(
      'Opens when posted',
    );
    const recent = new Date(NOW.getTime() - 2 * HOUR).toISOString();
    expect(text({ posting: { posted: true, posted_at: recent } }).appeals).toBe('Closes in 22 h 0 m');
    const old = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    expect(text({ posting: { posted: true, posted_at: old } }).appeals).toBe('Closed');
    const noTime = text({ posting: { posted: true, posted_at: null } });
    expect(noTime.appeals).toBe('Closed');
    expect(noTime.summary.appealClosesAt).toBeNull();
  });

  it('matches the FR5.3 example: 7 submissions (2 open), posted 3 h ago with a 24 h appeal period', () => {
    const { summary, submissions, appeals } = text({
      posting: { posted: true, posted_at: new Date(NOW.getTime() - 3 * HOUR).toISOString() },
      reportStatuses: ['open', 'logged', 'dismissed', 'open', 'logged', 'logged', 'dismissed'],
      appealStatuses: ['open', 'reviewed'],
    });
    expect(countLabel(summary.submissionsTotal, summary.submissionsOpen, 'submission')).toBe(
      '7 submissions (2 open)',
    );
    expect(countLabel(summary.appealsTotal, summary.appealsOpen, 'appeal')).toBe('2 appeals (1 open)');
    expect(submissions).toBe('Closed');
    expect(appeals).toBe('Closes in 21 h 0 m');
    expect(summary.subsessionId).toBe(8001);
  });
});

describe('getLatestEventSummary loader (BR5.3, BR5.10)', () => {
  const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(routes: (url: string) => unknown) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const body = routes(url);
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads one latest round, then that round only, and summarises it', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('limit=1')) return [ROUND];
      if (url.includes('curated_rounds')) {
        return [{ ...ROUND, subsession_id: 7001, start_time: '2026-10-28T18:00:00Z' }, { ...ROUND }];
      }
      if (url.includes('round_overrides')) return [];
      if (url.includes('round_incident_status')) return [];
      if (url.includes('incident_reports')) return [{ status: 'open' }, { status: 'logged' }];
      if (url.includes('incident_appeals')) return [];
      if (url.includes('events')) return [];
      if (url.includes('site_settings')) return [];
      return new Response('unexpected', { status: 500 });
    });

    const result = await getLatestEventSummary(env, 'admin-token', NOW);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.summary.label).toBe('ATC18, Round 2: Sonoma Raceway');
    expect(countLabel(result.summary.submissionsTotal, result.summary.submissionsOpen, 'submission')).toBe(
      '2 submissions (1 open)',
    );
    // No event: the round's own start time + 90 min + 24 h closes at 2026-11-05T19:30Z.
    expect(
      submissionWindowText(result.summary.submissionWindow, result.summary.submissionClosesAt, NOW),
    ).toBe('Closes in 7 h 30 m');
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls[0]).toContain('season_id=not.is.null');
    expect(urls[0]).toContain('order=start_time.desc,subsession_id.desc');
    expect(urls.filter((u) => u.includes('incident_reports') || u.includes('incident_appeals'))).toEqual([
      expect.stringContaining('subsession_id=eq.8001'),
      expect.stringContaining('subsession_id=eq.8001'),
    ]);
    const authed = fetchMock.mock.calls.find(([u]) => u.includes('incident_reports'))?.[1];
    expect((authed?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
  });

  it('gives "none" with no round, and "error" (logged) when a read fails', async () => {
    stubFetch(() => []);
    expect(await getLatestEventSummary(env, 'admin-token', NOW)).toEqual({ state: 'none' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((url) => (url.includes('limit=1') ? [ROUND] : new Response('boom', { status: 500 })));
    expect(await getLatestEventSummary(env, 'admin-token', NOW)).toEqual({ state: 'error' });
    expect(log).toHaveBeenCalled();
  });
});
