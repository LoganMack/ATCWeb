/**
 * The public Incident Submissions page: the session tables and the involved driver's Add Comment rows
 * (buildIncidentSubmissionsView), the columns it hides, and that no submission description or decision can
 * reach it: not from the database function, the view model, the page or its comment popup.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIncidentSubmissionsView,
  getIncidentSubmissions,
  getViewerCarNumber,
  INCIDENT_REPORT_ONLY_COLUMNS,
  INCIDENT_SUBMISSION_COL_WIDTHS,
  INCIDENT_SUBMISSION_COLUMNS,
  type IncidentSubmissionDbRow,
} from '../../src/lib/incidentSubmissions';
import { buildIncidentManagementRow, type MyIncidentDbRow } from '../../src/lib/incidents';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const R1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const R2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const R3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const R4 = 'aaaaaaaa-0000-4000-8000-000000000004';
const SECRET = 'Car 12 dive-bombed me at T1 <script>x</script>';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const FRAGMENT = read('src/pages/results/[subsessionId]/incidents/submissions/fragment.astro');
// The session tables live in a shared component (also shown to admins above the incidents table).
const TABLES = read('src/components/IncidentSubmissionsTables.astro');
const PAGE = `${FRAGMENT}\n${TABLES}`;
const MIGRATION = read('supabase/migrations/20261110120000_incident_submissions.sql');
// 20261111120000 replaces the function body (same signature), numbering by the shared order.
const ORDER_MIGRATION = read('supabase/migrations/20261111120000_incident_clips_and_ordering.sql');

/** The body of `create [or replace] function public.incident_submissions` in a migration. */
function submissionsBody(sql: string): string {
  const start = sql.search(/create (or replace )?function public\.incident_submissions\(/);
  const open = sql.indexOf('as $$', start);
  return sql.slice(open, sql.indexOf('$$;', open + 5));
}

const rows: IncidentSubmissionDbRow[] = [
  { id: R1, submission_number: 1, session: 'race:2', lap: 4, involved_cars: ['4', '12'] },
  { id: R2, submission_number: 2, session: 'qualifying:0', lap: 1, involved_cars: [] },
  { id: R3, submission_number: 3, session: 'race:1', lap: 9, involved_cars: ['7'] },
  { id: R4, submission_number: 4, session: 'race:2', lap: null, involved_cars: null },
];

function myPending(id: string, commented: boolean): MyIncidentDbRow {
  return {
    kind: 'pending_report',
    id,
    subsession_id: 1,
    round_label: 'Season 18 · Round 3 · Portland',
    occurred_at: null,
    session: 'race:2',
    lap: 4,
    turn: '1',
    description: SECRET,
    penalized_car: null,
    involved_cars: ['4'],
    i_am_penalized: false,
    my_comment_exists: commented,
    appeal_window_closes_at: null,
    my_appeal_status: 'none',
    points_before: null,
    points_after: null,
    time_or_points_changed: false,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buildIncidentSubmissionsView', () => {
  it('groups by session in event order: Practice, Qualifying, then the races', () => {
    const view = buildIncidentSubmissionsView(
      [...rows, { id: 'p1', submission_number: 5, session: 'practice:0', lap: 2, involved_cars: [] }],
      null,
    );
    expect(view.map((s) => s.label)).toEqual(['Practice', 'Qualifying', 'Race 1', 'Race 2']);
    expect(view[3].rows.map((r) => r.numberLabel)).toEqual(['1', '4']);
    expect(view[3].rows[0].involvedLabel).toBe('#4, #12');
    expect(view[3].rows[1].involvedLabel).toBe('—');
    expect(view[3].rows[1].lap).toBeNull();
  });

  it('puts Race 10 after Race 2 and unknown sessions last', () => {
    const view = buildIncidentSubmissionsView(
      [
        { id: 'a', submission_number: 1, session: 'heat:1', lap: 1, involved_cars: [] },
        { id: 'b', submission_number: 2, session: 'race:10', lap: 1, involved_cars: [] },
        { id: 'c', submission_number: 3, session: 'race:2', lap: 1, involved_cars: [] },
      ],
      null,
    );
    expect(view.map((s) => s.key)).toEqual(['race:2', 'race:10', 'heat:1']);
  });

  it('orders rows by their number, whatever order the database returns them in', () => {
    const view = buildIncidentSubmissionsView(
      [
        { id: 'x', submission_number: 7, session: 'race:1', lap: 9, involved_cars: [] },
        { id: 'y', submission_number: 2, session: 'race:1', lap: 3, involved_cars: [] },
        { id: 'z', submission_number: 5, session: 'race:1', lap: 4, involved_cars: [] },
      ],
      null,
    );
    expect(view[0].rows.map((r) => r.id)).toEqual(['y', 'z', 'x']);
  });

  it("marks the viewer's own car, car by car", () => {
    const view = buildIncidentSubmissionsView(rows, null, '12');
    const r1 = view.flatMap((s) => s.rows).find((r) => r.id === R1)!;
    expect(r1.involved).toEqual([
      { car: '4', mine: false },
      { car: '12', mine: true },
    ]);
    const others = view.flatMap((s) => s.rows).filter((r) => r.id !== R1);
    expect(others.flatMap((r) => r.involved).some((c) => c.mine)).toBe(false);
  });

  it('marks no car without a viewer, and compares car numbers as written', () => {
    for (const viewer of [null, '', '012']) {
      const cars = buildIncidentSubmissionsView(rows, null, viewer).flatMap((s) =>
        s.rows.flatMap((r) => r.involved),
      );
      expect(cars.some((c) => c.mine)).toBe(false);
    }
  });

  it('gives no comment buttons to a signed-out or uninvolved viewer', () => {
    for (const mine of [null, []]) {
      const view = buildIncidentSubmissionsView(rows, mine);
      expect(view.flatMap((s) => s.rows).every((r) => r.comment === null && !r.commentSent)).toBe(true);
    }
  });

  it("offers Add Comment only on the involved driver's uncommented reports", () => {
    const mine = [myPending(R1, false), myPending(R3, true)].map((r) =>
      buildIncidentManagementRow(r, new Date()),
    );
    const flat = buildIncidentSubmissionsView(rows, mine).flatMap((s) => s.rows);
    const byId = new Map(flat.map((r) => [r.id, r]));
    expect(byId.get(R1)!.comment).toEqual({
      roundLabel: 'Season 18 · Round 3 · Portland',
      sessionLabel: 'Race 2',
      lap: '4',
      turn: '1',
    });
    expect(byId.get(R3)!.comment).toBeNull();
    expect(byId.get(R3)!.commentSent).toBe(true);
    expect(byId.get(R2)!.comment).toBeNull();
  });

  it('never carries a description, even when my_incidents() returns one', () => {
    const mine = [buildIncidentManagementRow(myPending(R1, false), new Date())];
    const json = JSON.stringify(buildIncidentSubmissionsView(rows, mine));
    expect(json).not.toContain(SECRET);
    expect(json).not.toMatch(/description/i);
  });
});

describe('column hiding', () => {
  it("keeps only #, Lap and Involved from the Incident Report's table", () => {
    expect([...INCIDENT_SUBMISSION_COLUMNS]).toEqual(['#', 'Lap', 'Involved']);
    for (const column of INCIDENT_REPORT_ONLY_COLUMNS)
      expect(INCIDENT_SUBMISSION_COLUMNS).not.toContain(column);
  });

  it('renders no Driver, PP, Time, Pts or delta header on the page', () => {
    const headers = [...PAGE.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].trim());
    expect(headers.slice(0, 3)).toEqual([0, 1, 2].map((i) => `{INCIDENT_SUBMISSION_COLUMNS[${i}]}`));
    expect(headers[3]).toBe('<span class="sr-only">Actions</span>');
    expect(headers).toHaveLength(4);
    expect(PAGE).not.toMatch(/&Delta;|Δ|>\s*(Driver|PP|Time|Pts)\s*</);
  });

  it('gives every session table the same fixed column widths', () => {
    expect(TABLES).toMatch(/<table class="[^"]*\btable-fixed\b/);
    expect(TABLES).toMatch(/<colgroup>[\s\S]*INCIDENT_SUBMISSION_COL_WIDTHS\.map/);
    expect(INCIDENT_SUBMISSION_COL_WIDTHS).toHaveLength(INCIDENT_SUBMISSION_COLUMNS.length + 1);
  });

  it("shows the viewer's car in the brand pink with a screen-reader note", () => {
    expect(TABLES).toMatch(/car\.mine \? \(\s*<span class="[^"]*\btext-brand-pink\b/);
    expect(TABLES).toContain('<span class="sr-only"> (your car)</span>');
  });

  it('makes no row clickable and opens no details popup', () => {
    expect(PAGE).not.toMatch(
      /role="button"|tabindex=|cursor-pointer|data-incident-summary|data-mobile-incident-dialog/,
    );
  });
});

describe('no descriptions or decisions', () => {
  it('the page never reads or passes a description', () => {
    expect(PAGE).not.toMatch(/description/i);
  });

  it('the database function returns only id, number, session, lap and involved cars', () => {
    const returns = /returns table \(([^)]*)\)/.exec(MIGRATION)![1];
    expect(returns.split(',').map((c) => c.trim().split(' ')[0])).toEqual([
      'id',
      'submission_number',
      'session',
      'lap',
      'involved_cars',
    ]);
    const body = MIGRATION.slice(MIGRATION.indexOf('as $$'), MIGRATION.lastIndexOf('$$'));
    expect(body).not.toMatch(/description|reporter|\bturn\b|\bstatus\b|dismiss|review|penalt/i);
    expect(body).not.toMatch(/r\.status/);
    expect(MIGRATION).toMatch(/security definer/);
    expect(MIGRATION).toMatch(/grant execute on function public\.incident_submissions\(bigint\) to anon/);
  });

  it('the replaced function keeps its columns and still never reads text, turn, status or decisions', () => {
    const returns =
      /function public\.incident_submissions\(p_subsession_id bigint\)\s*returns table \(([^)]*)\)/.exec(
        ORDER_MIGRATION,
      )![1];
    expect(returns.split(',').map((c) => c.trim().split(' ')[0])).toEqual([
      'id',
      'submission_number',
      'session',
      'lap',
      'involved_cars',
    ]);
    const body = submissionsBody(ORDER_MIGRATION);
    expect(body).toContain('private.incident_report_order(p_subsession_id)');
    // The shared order sorts by turn and drops dismissed reports' numbers inside the database; the public
    // body only reads the number, so turn and status never leave through it.
    expect(body).not.toMatch(/description|reporter|\bturn\b|\bstatus\b|dismiss|review|penalt|video/i);
    expect(body).toMatch(/where o\.number is not null/);
    expect(ORDER_MIGRATION).toMatch(
      /grant execute on function public\.incident_submissions\(bigint\) to anon/,
    );
    expect(ORDER_MIGRATION).toMatch(
      /revoke all on function private\.incident_report_order\(bigint\) from public, anon, authenticated/,
    );
  });

  it('getIncidentSubmissions calls the function as the anonymous reader', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getIncidentSubmissions(env, 123)).resolves.toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/incident_submissions');
    expect(JSON.parse(init.body)).toEqual({ p_subsession_id: 123 });
    expect(init.headers.Authorization).toBe('Bearer anon-key');
  });

  it('getViewerCarNumber reads the public car number, and gives null on no driver or a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ car_number: 12 }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getViewerCarNumber(env, 'd-1')).resolves.toBe('12');
    expect(String(fetchMock.mock.calls[0][0])).toContain('drivers_shown?select=car_number&id=eq.d-1');
    await expect(getViewerCarNumber(env, null)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(getViewerCarNumber(env, 'd-1')).resolves.toBeNull();
  });
});
