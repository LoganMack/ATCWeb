/**
 * Adjusted incident counts (results-edit, US9.2) and the Edit Results banner (US9.1).
 */
import { describe, expect, it } from 'vitest';
import {
  INCIDENTS_RESULT_CODES,
  incidentAdjustmentLabel,
  incidentsResultMessage,
  isIncidentsResultCode,
} from '../../src/lib/results/incidentAdjustment';

describe('incidentAdjustmentLabel', () => {
  it('names the original and the current count', () => {
    expect(incidentAdjustmentLabel(3, 5)).toBe('Incidents adjusted from 3 to 5.');
    expect(incidentAdjustmentLabel(4, 0)).toBe('Incidents adjusted from 4 to 0.');
  });

  it('is null when the count was never changed or is back to the original', () => {
    expect(incidentAdjustmentLabel(null, 5)).toBeNull();
    expect(incidentAdjustmentLabel(undefined, 5)).toBeNull();
    expect(incidentAdjustmentLabel(5, 5)).toBeNull();
    expect(incidentAdjustmentLabel(3, null)).toBeNull();
  });
});

describe('incidentsResultMessage', () => {
  it('has a message for every result code', () => {
    for (const code of INCIDENTS_RESULT_CODES) {
      const message = incidentsResultMessage(code, 'Zi Driver');
      expect(message.text.length, code).toBeGreaterThan(0);
    }
  });

  it('reports success and the scoring-issue warning', () => {
    expect(incidentsResultMessage('saved')).toEqual({ tone: 'success', text: 'Incident counts saved.' });
    expect(incidentsResultMessage('scoring_issue')).toEqual({
      tone: 'warning',
      text: "Incident counts saved, but the round couldn't be scored. Check the round's results and season setup.",
    });
  });

  it('names the refused driver when known, and reads naturally without one', () => {
    expect(incidentsResultMessage('invalid_count', 'Zi Driver').text).toContain('for Zi Driver');
    expect(incidentsResultMessage('invalid_count').text).toBe(
      'Invalid incident count. Use a whole number from 0 to 999. Nothing was saved.',
    );
    expect(incidentsResultMessage('not_in_race', 'Zi Driver').text).toMatch(/^Zi Driver is not in this race/);
    expect(incidentsResultMessage('not_in_race').text).toMatch(/^A driver is not in this race/);
    expect(incidentsResultMessage('season_locked').tone).toBe('error');
  });

  it('accepts only known codes from the URL', () => {
    expect(isIncidentsResultCode('saved')).toBe(true);
    expect(isIncidentsResultCode('<script>')).toBe(false);
    expect(isIncidentsResultCode(null)).toBe(false);
  });
});
