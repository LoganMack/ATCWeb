/**
 * The shared report order (FR2.3, BR2.1): the admin Reported Incidents screen puts reports in the database's
 * order with applyReportOrder, and the public Incident Submissions page shows the numbers incident_submissions()
 * returns. Both come from the same order rows, so the same report gets the same number on both screens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyReportOrder, getIncidentReportOrder, type ReportOrderRow } from '../../src/lib/incidentOrder';
import { sortIncidentRowsNewestFirst, type IncidentRow } from '../../src/lib/incidents';
import {
  buildIncidentSubmissionsView,
  type IncidentSubmissionDbRow,
} from '../../src/lib/incidentSubmissions';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };

interface Report {
  id: string;
  created_at: string;
  session: string;
  lap: number;
  status: 'open' | 'logged' | 'dismissed';
}

// Submission times run against the event order, so a time sort would give a different list.
const reports: Report[] = [
  { id: 'r-a', created_at: '2026-06-10T20:00:00Z', session: 'race:1', lap: 2, status: 'open' },
  { id: 'r-b', created_at: '2026-06-10T19:00:00Z', session: 'race:1', lap: 1, status: 'dismissed' },
  { id: 'r-c', created_at: '2026-06-10T21:00:00Z', session: 'qualifying:0', lap: 3, status: 'logged' },
  { id: 'r-d', created_at: '2026-06-10T18:00:00Z', session: 'race:2', lap: 1, status: 'open' },
];

// As private.incident_report_order would return them: Qualifying, Race 1 lap 1 (dismissed), Race 1 lap 2, Race 2.
const order: ReportOrderRow[] = [
  { report_id: 'r-c', position: 1, number: 1 },
  { report_id: 'r-b', position: 2, number: null },
  { report_id: 'r-a', position: 3, number: 2 },
  { report_id: 'r-d', position: 4, number: 3 },
];

afterEach(() => vi.unstubAllGlobals());

describe('applyReportOrder', () => {
  it("lists reports in the database's order, dismissed ones in place but unnumbered", () => {
    const { reports: ordered, numbers } = applyReportOrder(reports, order);
    expect(ordered.map((r) => r.id)).toEqual(['r-c', 'r-b', 'r-a', 'r-d']);
    expect([...numbers]).toEqual([
      ['r-c', 1],
      ['r-a', 2],
      ['r-d', 3],
    ]);
    expect(numbers.has('r-b')).toBe(false);
  });

  it('puts a report the order does not know last, unnumbered, by submission time', () => {
    const late: Report[] = [
      ...reports,
      { id: 'r-y', created_at: '2026-06-11T09:00:00Z', session: 'practice:0', lap: 1, status: 'open' },
      { id: 'r-x', created_at: '2026-06-11T08:00:00Z', session: 'practice:0', lap: 1, status: 'open' },
    ];
    const { reports: ordered, numbers } = applyReportOrder(late, order);
    expect(ordered.map((r) => r.id)).toEqual(['r-c', 'r-b', 'r-a', 'r-d', 'r-x', 'r-y']);
    expect(numbers.has('r-x') || numbers.has('r-y')).toBe(false);
  });

  it('with no order (a failed read) lists by submission time with no numbers', () => {
    const { reports: ordered, numbers } = applyReportOrder(reports, null);
    expect(ordered.map((r) => r.id)).toEqual(['r-d', 'r-b', 'r-a', 'r-c']);
    expect(numbers.size).toBe(0);
  });

  it('handles no reports and ignores order rows for reports it was not given', () => {
    expect(applyReportOrder([], order)).toEqual({ reports: [], numbers: new Map() });
    const { reports: ordered, numbers } = applyReportOrder([reports[3]], order);
    expect(ordered.map((r) => r.id)).toEqual(['r-d']);
    expect([...numbers]).toEqual([['r-d', 3]]);
  });

  it('does not change the list it was given', () => {
    const copy = reports.map((r) => r.id);
    applyReportOrder(reports, order);
    expect(reports.map((r) => r.id)).toEqual(copy);
  });
});

describe('admin and public numbers match (FR2.3)', () => {
  it('gives every report the same number on both screens', () => {
    const adminNumbers = applyReportOrder(reports, order).numbers;

    // incident_submissions() returns the numbered reports with the order's number (the SQL fixture K01
    // checks the database side of this).
    const byId = new Map(reports.map((r) => [r.id, r]));
    const publicRows: IncidentSubmissionDbRow[] = order
      .filter((row) => row.number !== null)
      .map((row) => ({
        id: row.report_id,
        submission_number: row.number!,
        session: byId.get(row.report_id)!.session,
        lap: byId.get(row.report_id)!.lap,
        involved_cars: [],
      }));
    const publicNumbers = new Map(
      buildIncidentSubmissionsView(publicRows, null)
        .flatMap((s) => s.rows)
        .map((r) => [r.id, Number(r.numberLabel)] as const),
    );

    expect(Object.fromEntries(publicNumbers)).toEqual(Object.fromEntries(adminNumbers));
    expect(publicNumbers.has('r-b')).toBe(false);
  });
});

// --- The All Incidents table's initial order (nav-admin-polish FR1.3; BR1.3-BR1.7) -------------------------

function incident(id: string, over: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id,
    subsessionId: 100,
    seasonLabel: 'ATC18',
    displayRoundNumber: 1,
    trackName: 'Track',
    startTime: '2026-10-01T18:00:00Z',
    sessionType: 'race',
    raceNumber: 1,
    incidentNumber: null,
    lap: 1,
    driver: null,
    involvedDrivers: [],
    offenseIds: [],
    offenseNames: [],
    penaltyPoints: 0,
    timePenaltySeconds: null,
    pointsPenalty: 0,
    isWarning: false,
    isAppealed: false,
    description: null,
    createdAt: '2026-10-01T20:00:00Z',
    ...over,
  };
}

const ids = (rows: IncidentRow[]) => rows.map((r) => r.id);

describe('sortIncidentRowsNewestFirst', () => {
  it('lists every incident of the newer season before any of the older one', () => {
    const rows = [
      incident('old-r9', { seasonLabel: 'ATC17', displayRoundNumber: 9, startTime: '2026-03-01T18:00:00Z' }),
      incident('new-r1', { seasonLabel: 'ATC18', displayRoundNumber: 1, startTime: '2026-09-01T18:00:00Z' }),
      incident('old-r1', { seasonLabel: 'ATC17', displayRoundNumber: 1, startTime: '2026-01-01T18:00:00Z' }),
      incident('new-r2', { seasonLabel: 'ATC18', displayRoundNumber: 2, startTime: '2026-09-08T18:00:00Z' }),
    ];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['new-r2', 'new-r1', 'old-r9', 'old-r1']);
  });

  it('orders one round as Race 2 lap 10, Race 2 lap 3, Race 1 lap 12, Qualifying lap 2, then Practice', () => {
    const rows = [
      incident('q2', { sessionType: 'qualifying', raceNumber: 0, lap: 2 }),
      incident('r1l12', { raceNumber: 1, lap: 12 }),
      incident('p5', { sessionType: 'practice', raceNumber: 0, lap: 5 }),
      incident('r2l3', { raceNumber: 2, lap: 3 }),
      incident('r2l10', { raceNumber: 2, lap: 10 }),
    ];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['r2l10', 'r2l3', 'r1l12', 'q2', 'p5']);
  });

  it('lists an incident with no lap after the lapped ones of its session', () => {
    const rows = [
      incident('r1-none', { raceNumber: 1, lap: null }),
      incident('r1l4', { raceNumber: 1, lap: 4 }),
      incident('q1', { sessionType: 'qualifying', raceNumber: 0, lap: 1 }),
      incident('r1l9', { raceNumber: 1, lap: 9 }),
    ];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['r1l9', 'r1l4', 'r1-none', 'q1']);
  });

  it('puts exhibitions after the numbered rounds of their season, later exhibition first', () => {
    const rows = [
      incident('exh-early', {
        subsessionId: 201,
        displayRoundNumber: null,
        startTime: '2026-09-02T18:00:00Z',
      }),
      incident('r1', { subsessionId: 101, displayRoundNumber: 1, startTime: '2026-09-01T18:00:00Z' }),
      incident('exh-late', {
        subsessionId: 202,
        displayRoundNumber: null,
        startTime: '2026-09-20T18:00:00Z',
      }),
      incident('r2', { subsessionId: 102, displayRoundNumber: 2, startTime: '2026-09-08T18:00:00Z' }),
    ];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['r2', 'r1', 'exh-late', 'exh-early']);
  });

  it('lists rounds with no season after every season', () => {
    const rows = [
      incident('no-season', {
        seasonLabel: null,
        displayRoundNumber: null,
        startTime: '2026-12-01T18:00:00Z',
      }),
      incident('old-season', { seasonLabel: 'ATC10', startTime: '2020-01-01T18:00:00Z' }),
    ];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['old-season', 'no-season']);
  });

  it('keeps the given order when every key ties', () => {
    const rows = [incident('first'), incident('second'), incident('third')];
    expect(ids(sortIncidentRowsNewestFirst(rows))).toEqual(['first', 'second', 'third']);
  });

  it('returns a new list and leaves the input alone', () => {
    const rows = [incident('a', { lap: 1 }), incident('b', { lap: 2 })];
    const sorted = sortIncidentRowsNewestFirst(rows);
    expect(ids(sorted)).toEqual(['b', 'a']);
    expect(ids(rows)).toEqual(['a', 'b']);
    expect(sorted).not.toBe(rows);
  });
});

describe('getIncidentReportOrder', () => {
  it("calls the admin order function with the steward's token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(order), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getIncidentReportOrder(env, 'steward-token', 42)).resolves.toEqual(order);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/incident_report_order');
    expect(JSON.parse(init.body)).toEqual({ p_subsession_id: 42 });
    expect(init.headers.Authorization).toBe('Bearer steward-token');
  });

  it('returns null when the database refuses or fails, so the page can still list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"code":"42501"}', { status: 403 })));
    await expect(getIncidentReportOrder(env, 'token', 42)).resolves.toBeNull();
  });
});
