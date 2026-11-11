/**
 * The admin dashboard's latest-event card (FR5; BR5.1-BR5.6): title and track, the review counts, window
 * wording, the time format, and the loader's reads and fallbacks. Every case uses a fixed `now`; the loader runs
 * against a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appealWindowText,
  formatTimeLeft,
  getLatestEventSummary,
  incidentWindowText,
  latestEventTitle,
  reportGroups,
  summariseLatestEvent,
  toReviewLabel,
  type LatestEventInputs,
  type LatestEventReport,
  type LatestRound,
} from '../../src/lib/adminLatestEvent';
import { countFilters } from '../../src/lib/incidentReportFilters';

const NOW = new Date('2026-11-05T12:00:00Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const ME = 'user-me';
const MY_DRIVER = 'driver-me';

const ROUND: LatestRound = {
  subsession_id: 8001,
  season_id: 'season-18',
  season_label: 'ATC18',
  start_time: '2026-11-04T18:00:00Z',
  track_name: 'Sonoma Raceway',
  event_id: null,
};

function report(id: string, over: Partial<LatestEventReport> = {}): LatestEventReport {
  return { id, status: 'open', reviews_closed_at: null, driver_ids: ['driver-a', 'driver-b'], ...over };
}

function inputs(over: Partial<LatestEventInputs> = {}): LatestEventInputs {
  return {
    round: ROUND,
    displayNumber: 8,
    posting: null,
    reports: [],
    myReviewedReportIds: new Set(),
    viewerDriverId: MY_DRIVER,
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
    incidents: incidentWindowText(s.submissionWindow, s.submissionClosesAt, NOW),
    appeals: appealWindowText(s.appealWindow, s.appealClosesAt, NOW),
    summary: s,
  };
}

describe('time left (BR5.5)', () => {
  it('reads hours and minutes under a day, minutes rounded up', () => {
    expect(formatTimeLeft(1)).toBe('0h1m');
    expect(formatTimeLeft(12 * MIN)).toBe('0h12m');
    expect(formatTimeLeft(5 * HOUR)).toBe('5h0m');
    expect(formatTimeLeft(5 * HOUR - 30_000)).toBe('5h0m');
    expect(formatTimeLeft(15 * HOUR + 17 * MIN)).toBe('15h17m');
    expect(formatTimeLeft(23 * HOUR + 59 * MIN)).toBe('23h59m');
  });

  it('reads days and hours from exactly one day', () => {
    expect(formatTimeLeft(24 * HOUR)).toBe('1d0h');
    expect(formatTimeLeft(39 * HOUR)).toBe('1d15h');
    expect(formatTimeLeft(2 * 24 * HOUR + 3 * HOUR + 10 * MIN)).toBe('2d3h');
  });
});

describe('title and counts (BR5.1, BR5.6)', () => {
  it('titles the round with season and round number or Exhibition, with the track separate', () => {
    expect(latestEventTitle(ROUND, 8)).toBe('ATC18, Round 8');
    expect(latestEventTitle(ROUND, null)).toBe('ATC18, Exhibition');
    expect(latestEventTitle({ ...ROUND, season_label: null }, 3)).toBe('Round 3');
    const s = summariseLatestEvent(inputs());
    expect(s.title).toBe('ATC18, Round 8');
    expect(s.trackName).toBe('Sonoma Raceway');
  });

  it('words the counts with singular for exactly one', () => {
    expect(toReviewLabel(6, 'Incident')).toBe('6 Incidents to Review');
    expect(toReviewLabel(1, 'Incident')).toBe('1 Incident to Review');
    expect(toReviewLabel(0, 'Appeal')).toBe('0 Appeals to Review');
    expect(toReviewLabel(1, 'Appeal')).toBe('1 Appeal to Review');
  });
});

describe('Incidents to Review (BR5.2) and Appeals to Review (BR5.3)', () => {
  const reports = [
    report('open-1'),
    report('open-2'),
    report('reviewed-by-me'),
    report('involved', { driver_ids: ['driver-a', MY_DRIVER] }),
    report('voting-closed', { reviews_closed_at: '2026-11-05T10:00:00Z' }),
    report('logged', { status: 'logged' }),
    report('dismissed', { status: 'dismissed' }),
  ];
  const reviewed = new Set(['reviewed-by-me']);

  it('counts only open reports the viewer has not reviewed, is not in, and whose voting is still open', () => {
    const s = summariseLatestEvent(inputs({ reports, myReviewedReportIds: reviewed }));
    expect(s.incidentsToReview).toBe(2);
  });

  it('matches the Needs Review count the Reported Incidents filters give for the same reports', () => {
    const groups = reportGroups(reports, reviewed, MY_DRIVER);
    const s = summariseLatestEvent(inputs({ reports, myReviewedReportIds: reviewed }));
    expect(s.incidentsToReview).toBe(countFilters(groups).needs_review);
  });

  it('counts a report naming the viewer’s car as theirs to review when they have no linked driver', () => {
    const s = summariseLatestEvent(inputs({ reports, myReviewedReportIds: reviewed, viewerDriverId: null }));
    expect(s.incidentsToReview).toBe(3);
  });

  it('counts open appeals only', () => {
    expect(
      summariseLatestEvent(inputs({ appealStatuses: ['open', 'reviewed', 'open'] })).appealsToReview,
    ).toBe(2);
    expect(summariseLatestEvent(inputs()).appealsToReview).toBe(0);
  });
});

describe('window wording (BR5.4)', () => {
  it('reads the incident window as remaining, or closed once past, posted or unknown', () => {
    expect(text().incidents).toBe('Incidents: 5h0m Remaining');
    const past = {
      raceOverUtc: new Date(NOW.getTime() - 30 * HOUR),
      closesUtc: new Date(NOW.getTime() - HOUR),
    };
    expect(text({ reportingWindow: past }).incidents).toBe('Incidents: Closed');
    expect(text({ posting: { posted: true, posted_at: NOW.toISOString() } }).incidents).toBe(
      'Incidents: Closed',
    );
    expect(text({ reportingWindow: null }).incidents).toBe('Incidents: Closed');
  });

  it('reads the appeal window as not open yet, remaining or closed', () => {
    expect(text().appeals).toBe('Appeal: Not Open Yet');
    const recent = new Date(NOW.getTime() - 2 * HOUR).toISOString();
    expect(text({ posting: { posted: true, posted_at: recent } }).appeals).toBe('Appeal: 22h0m Remaining');
    const old = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    expect(text({ posting: { posted: true, posted_at: old } }).appeals).toBe('Appeal: Closed');
    expect(text({ posting: { posted: true, posted_at: null } }).appeals).toBe('Appeal: Closed');
  });
});

describe('getLatestEventSummary loader', () => {
  const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
  const viewer = { userId: ME, driverId: MY_DRIVER };

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

  const drivers = (...ids: string[]) => ids.map((driver_id) => ({ driver_id }));

  it('reads one latest round, then that round only, and counts what awaits the viewer', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('limit=1')) return [ROUND];
      if (url.includes('curated_rounds')) {
        return [{ ...ROUND, subsession_id: 7001, start_time: '2026-10-28T18:00:00Z' }, { ...ROUND }];
      }
      if (url.includes('round_overrides')) return [];
      if (url.includes('round_incident_status')) return [];
      if (url.includes('incident_report_reviews')) return [{ report_id: 'r2' }];
      if (url.includes('incident_reports')) {
        return [
          { id: 'r1', status: 'open', reviews_closed_at: null, incident_report_drivers: drivers('d1', 'd2') },
          { id: 'r2', status: 'open', reviews_closed_at: null, incident_report_drivers: drivers('d1', 'd3') },
          { id: 'r3', status: 'open', reviews_closed_at: null, incident_report_drivers: drivers(MY_DRIVER) },
          { id: 'r4', status: 'logged', reviews_closed_at: null, incident_report_drivers: drivers('d4') },
        ];
      }
      if (url.includes('incident_appeals')) return [{ status: 'open' }];
      if (url.includes('events')) return [];
      if (url.includes('site_settings')) return [];
      return new Response('unexpected', { status: 500 });
    });

    const result = await getLatestEventSummary(env, 'admin-token', viewer, NOW);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.summary.title).toBe('ATC18, Round 2');
    expect(result.summary.trackName).toBe('Sonoma Raceway');
    expect(result.summary.incidentsToReview).toBe(1);
    expect(result.summary.appealsToReview).toBe(1);
    // No event: the round's own start time + 90 min + 24 h closes at 2026-11-05T19:30Z.
    expect(incidentWindowText(result.summary.submissionWindow, result.summary.submissionClosesAt, NOW)).toBe(
      'Incidents: 7h30m Remaining',
    );
    const urls = fetchMock.mock.calls.map(([u]) => u);
    expect(urls[0]).toContain('season_id=not.is.null');
    const reviews = urls.find((u) => u.includes('incident_report_reviews'));
    expect(reviews).toContain(`reviewer_id=eq.${ME}`);
    expect(reviews).toContain('incident_reports.subsession_id=eq.8001');
    const authed = fetchMock.mock.calls.find(([u]) => u.includes('incident_reports?'))?.[1];
    expect((authed?.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
  });

  it('gives "none" with no round, and "error" (logged) when the reviews read fails', async () => {
    stubFetch(() => []);
    expect(await getLatestEventSummary(env, 'admin-token', viewer, NOW)).toEqual({ state: 'none' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch((url) => {
      if (url.includes('limit=1')) return [ROUND];
      if (url.includes('incident_report_reviews')) return new Response('boom', { status: 500 });
      return [];
    });
    expect(await getLatestEventSummary(env, 'admin-token', viewer, NOW)).toEqual({ state: 'error' });
    expect(log).toHaveBeenCalled();
  });
});
