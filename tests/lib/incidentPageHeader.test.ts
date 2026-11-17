import { describe, expect, it } from 'vitest';
import { incidentSubtitle, postReportState } from '../../src/lib/incidentPageHeader';

const START = '2026-11-16T19:00:00Z';

describe('incidentSubtitle', () => {
  it('shows the short date, the season and the round number', () => {
    expect(incidentSubtitle(START, 'ATC18', 8)).toBe('Nov 16, 2026 - ATC18, Round 8');
  });

  it('reads Exhibition for a round with no number', () => {
    expect(incidentSubtitle(START, 'ATC18', null)).toBe('Nov 16, 2026 - ATC18, Exhibition');
  });

  it('shows the date alone without a season', () => {
    expect(incidentSubtitle(START, null, 3)).toBe('Nov 16, 2026');
    expect(incidentSubtitle(START, '  ', 3)).toBe('Nov 16, 2026');
  });

  it('treats a round number that failed to load as unnumbered', () => {
    expect(incidentSubtitle(START, 'ATC18', undefined)).toBe('Nov 16, 2026 - ATC18, Exhibition');
  });
});

describe('postReportState', () => {
  const window = {
    raceOverUtc: new Date('2026-11-16T21:00:00Z'),
    closesUtc: new Date('2026-11-17T21:00:00Z'),
  };

  it('is disabled while incident submissions are open', () => {
    expect(postReportState(window, new Date('2026-11-17T12:00:00Z'))).toBe('disabled');
  });

  it('is enabled once submissions have closed', () => {
    expect(postReportState(window, new Date('2026-11-18T00:00:00Z'))).toBe('enabled');
  });

  it('is enabled when the window is unknown', () => {
    expect(postReportState(null, new Date('2026-11-17T12:00:00Z'))).toBe('enabled');
  });

  it('is enabled at exactly the closing time', () => {
    expect(postReportState(window, new Date('2026-11-17T21:00:00Z'))).toBe('enabled');
  });
});
