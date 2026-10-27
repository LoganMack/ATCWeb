/**
 * Edit Submission (broadcaster-staff-roles, BR4.1-BR4.5): the request editIncidentReportSubmission sends to
 * edit_incident_report_submission and how its errors become messages. The rules themselves are checked in
 * supabase/checks/staff-broadcaster-fixtures.sql (T16-T20). PostgREST responses are stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDIT_SUBMISSION_MESSAGES,
  editIncidentReportSubmission,
  mapEditSubmissionError,
} from '../../src/lib/incidentReports';

const env = { url: 'https://project.example.test', anonKey: 'anon-key' };
const REPORT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const input = {
  report_id: REPORT_ID,
  session: 'race:2',
  lap: 5,
  turn: 'T2',
  driver_ids: ['11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000002'],
};

const respond = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const raised = (message: string) => respond({ code: 'P0001', message, details: null, hint: null }, 400);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editIncidentReportSubmission', () => {
  it('posts the four fields and the report id with the caller token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ changed: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(editIncidentReportSubmission(env, 'staff-token', input)).resolves.toEqual({
      ok: true,
      changed: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://project.example.test/rest/v1/rpc/edit_incident_report_submission');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer staff-token');
    expect(JSON.parse(init.body)).toEqual({
      p_report_id: REPORT_ID,
      p_session: 'race:2',
      p_lap: 5,
      p_turn: 'T2',
      p_driver_ids: input.driver_ids,
    });
  });

  it('reports a save that changed nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ changed: false })));
    await expect(editIncidentReportSubmission(env, 'staff-token', input)).resolves.toEqual({
      ok: true,
      changed: false,
    });
  });

  it('turns REPORT_NOT_OPEN into its message and logs the code only', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(raised("REPORT_NOT_OPEN: This report is no longer open, so it can't be edited")),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await editIncidentReportSubmission(env, 'staff-token', input);
    expect(result).toEqual({
      ok: false,
      code: 'REPORT_NOT_OPEN',
      field: null,
      message: "This report is no longer open, so it can't be edited.",
    });
    expect(error).toHaveBeenCalledWith('edit_incident_report_submission failed', 'REPORT_NOT_OPEN');
  });

  it('turns REPORT_NOT_FOUND into its message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(raised('REPORT_NOT_FOUND: That incident report no longer exists')),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await editIncidentReportSubmission(env, 'staff-token', input);
    expect(result.ok === false && result.message).toBe(EDIT_SUBMISSION_MESSAGES.REPORT_NOT_FOUND);
  });

  it('names the field of an INVALID error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raised('INVALID: lap: Enter a lap from 0 to 1000')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await editIncidentReportSubmission(env, 'staff-token', input)).toEqual({
      ok: false,
      code: 'INVALID',
      field: 'lap',
      message: 'Enter a lap from 0 to 1000.',
    });
  });

  it('falls back to a generic message for a permission error, an unknown error or no network', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond({ code: '42501', message: 'Only an admin or staff member can edit' }, 403),
        ),
    );
    const refused = await editIncidentReportSubmission(env, 'driver-token', input);
    expect(refused).toMatchObject({ ok: false, code: 'UNKNOWN', message: EDIT_SUBMISSION_MESSAGES.UNKNOWN });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await editIncidentReportSubmission(env, 'staff-token', input)).ok).toBe(false);
  });
});

describe('mapEditSubmissionError', () => {
  it('ignores a field name the form does not have', () => {
    expect(mapEditSubmissionError('INVALID: description: too long')).toMatchObject({
      code: 'UNKNOWN',
      field: null,
    });
    expect(mapEditSubmissionError('INVALID: driver_ids: Pick between 1 and 100 cars')).toMatchObject({
      code: 'INVALID',
      field: 'driver_ids',
    });
  });
});
