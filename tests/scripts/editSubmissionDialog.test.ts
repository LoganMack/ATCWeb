/**
 * Edit Submission on the incidents page (broadcaster-staff-roles C8, BR4.1-BR4.5): reading a button's prefill,
 * what the popup posts, which flash a save shows, and the markup rules (the button on open reports only, the
 * removed review line, the halved ring without a label). The rules themselves run in the database
 * (supabase/checks/staff-broadcaster-fixtures.sql T16-T20).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseSubmissionPrefill } from '../../src/scripts/editSubmissionDialog';
import {
  readSubmissionForm,
  submissionFlashFor,
  SUBMISSION_FLASH_MESSAGES,
} from '../../src/lib/incidentActions/editReportSubmission';

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const FRAGMENT = raw(
  import.meta.glob('/src/pages/results/[subsessionId]/incidents/fragment.astro', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)['/src/pages/results/[subsessionId]/incidents/fragment.astro'];
const DIALOG = raw(
  import.meta.glob('/src/components/ReportIncidentDialog.astro', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)['/src/components/ReportIncidentDialog.astro'];

let GLOBAL_CSS = '';
beforeAll(async () => {
  const fs = await import('node:fs/promises' as string);
  GLOBAL_CSS = await fs.readFile(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
});

describe('parseSubmissionPrefill', () => {
  it('reads the report id and the four fields', () => {
    expect(
      parseSubmissionPrefill(
        '{"report_id":"r-1","session":"race:2","lap":5,"turn":"T2","driver_ids":["a","b"]}',
      ),
    ).toEqual({ report_id: 'r-1', session: 'race:2', lap: 5, turn: 'T2', driver_ids: ['a', 'b'] });
  });

  it('leaves odd fields empty and refuses anything without a report id', () => {
    expect(parseSubmissionPrefill('{"report_id":"r-1","lap":"5","driver_ids":[1,"a"]}')).toEqual({
      report_id: 'r-1',
      session: '',
      lap: null,
      turn: '',
      driver_ids: ['a'],
    });
    expect(parseSubmissionPrefill('{"session":"race:1"}')).toBeNull();
    expect(parseSubmissionPrefill('nope')).toBeNull();
    expect(parseSubmissionPrefill(undefined)).toBeNull();
  });
});

describe('readSubmissionForm', () => {
  it('reads the popup fields, every ticked car and a trimmed turn', () => {
    const form = new FormData();
    form.set('report_id', 'r-1');
    form.set('session', 'race:1');
    form.set('lap', ' 7 ');
    form.set('turn', '  T3 ');
    form.append('involved_driver_ids', 'a');
    form.append('involved_driver_ids', 'b');
    expect(readSubmissionForm(form)).toEqual({
      report_id: 'r-1',
      session: 'race:1',
      lap: 7,
      turn: 'T3',
      driver_ids: ['a', 'b'],
    });
  });

  it('sends a lap the database will refuse when it is not a whole number', () => {
    const form = new FormData();
    form.set('lap', '1e3');
    expect(readSubmissionForm(form).lap).toBe(-1);
  });
});

describe('submissionFlashFor', () => {
  it('names each outcome', () => {
    expect(submissionFlashFor({ ok: true, changed: true })).toBe('updated');
    expect(submissionFlashFor({ ok: true, changed: false })).toBe('unchanged');
    expect(submissionFlashFor({ ok: false, code: 'REPORT_NOT_OPEN', field: null, message: '' })).toBe(
      'notopen',
    );
    expect(submissionFlashFor({ ok: false, code: 'REPORT_NOT_FOUND', field: null, message: '' })).toBe(
      'notfound',
    );
    expect(submissionFlashFor({ ok: false, code: 'INVALID', field: 'lap', message: '' })).toBe('invalid');
    expect(submissionFlashFor({ ok: false, code: 'UNKNOWN', field: null, message: '' })).toBe('failed');
    expect(SUBMISSION_FLASH_MESSAGES.updated.message).toBe('Submission updated.');
    expect(SUBMISSION_FLASH_MESSAGES.notopen.message).toBe(
      "This report is no longer open, so it can't be edited.",
    );
  });
});

describe('the incidents screen markup', () => {
  it('puts Edit Submission after Add to Report, on open reports only', () => {
    const add = FRAGMENT.search(/>\s*Add to Report\s*</);
    const edit = FRAGMENT.search(/>\s*Edit Submission\s*</);
    expect(add).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(add);
    expect(FRAGMENT.slice(add, edit)).toMatch(
      /\{r\.status === 'open' && \(\s*<button\s+type="button"\s+data-edit-submission=/,
    );
    expect(FRAGMENT).toMatch(/data-edit-submission=[\s\S]{0,200}class="btn btn-gold btn-sm"/);
    expect(FRAGMENT).toContain("['edit-report-submission', handleEditReportSubmission]");
  });

  it('drops the "Submit your own review" line', () => {
    expect(FRAGMENT).not.toContain('Submit your own review');
  });

  it('gives the dialog an edit mode with no description or honeypot', () => {
    expect(FRAGMENT).toMatch(/<ReportIncidentDialog\s+mode="edit"/);
    expect(DIALOG).toContain("{editing ? 'Edit Submission' : 'Report Incident'}");
    expect(DIALOG).toContain("value={editing ? 'edit-report-submission' : 'report-incident'}");
    expect(DIALOG).toMatch(/\{!editing && \(\s*<label[^>]*>\s*Description/);
    expect(DIALOG).toContain('Save Changes');
  });

  it('halves the View Map ring and drops its label', () => {
    expect(GLOBAL_CSS).toMatch(/\.map-turn-ring \{[^}]*width: 10%;/);
    expect(GLOBAL_CSS).toMatch(/\.map-plate-dialog \.map-turn-ring \{\s*width: 6%;/);
    expect(GLOBAL_CSS).not.toContain('.map-turn-ring > b');
  });
});
