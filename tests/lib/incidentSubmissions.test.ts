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
  INCIDENT_REPORT_ONLY_COLUMNS,
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
const PAGE = read('src/pages/results/[subsessionId]/incidents/submissions/fragment.astro');
const MIGRATION = read('supabase/migrations/20261110120000_incident_submissions.sql');

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
  it('groups by session in race order, then Qualifying, keeping submission order', () => {
    const view = buildIncidentSubmissionsView(rows, null);
    expect(view.map((s) => s.label)).toEqual(['Race 1', 'Race 2', 'Qualifying']);
    expect(view[1].rows.map((r) => r.numberLabel)).toEqual(['1', '4']);
    expect(view[1].rows[0].involvedLabel).toBe('#4, #12');
    expect(view[1].rows[1].involvedLabel).toBe('—');
    expect(view[1].rows[1].lap).toBeNull();
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
    // Dismissed and logged reports are listed like open ones, so the list can't show a decision.
    expect(body).not.toMatch(/r\.status/);
    expect(MIGRATION).toMatch(/security definer/);
    expect(MIGRATION).toMatch(/grant execute on function public\.incident_submissions\(bigint\) to anon/);
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
});
