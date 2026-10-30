/**
 * The shared report order (FR2.3, BR2.1): the admin Reported Incidents screen puts reports in the database's
 * order with applyReportOrder, and the public Incident Submissions page shows the numbers incident_submissions()
 * returns. Both come from the same order rows, so the same report gets the same number on both screens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyReportOrder, getIncidentReportOrder, type ReportOrderRow } from '../../src/lib/incidentOrder';
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
