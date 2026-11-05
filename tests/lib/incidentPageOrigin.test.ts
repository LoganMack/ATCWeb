/**
 * The round incident page's origin marker (FR2.3-FR2.5; BR2.3-BR2.5): only `from=reporting` counts, it
 * picks the one back link, and links that stay on the page keep it.
 */
import { describe, expect, it } from 'vitest';
import {
  INCIDENT_ORIGIN_PARAM,
  incidentBackLink,
  parseIncidentOrigin,
  withIncidentOrigin,
} from '../../src/lib/incidentPageOrigin';

describe('parseIncidentOrigin (BR2.4)', () => {
  it('honours exactly "reporting"', () => {
    expect(INCIDENT_ORIGIN_PARAM).toBe('from');
    expect(parseIncidentOrigin(new URLSearchParams('from=reporting'))).toBe('reporting');
    expect(parseIncidentOrigin('reporting')).toBe('reporting');
  });

  it('ignores other values, upper case, empty and missing', () => {
    for (const query of [
      'from=REPORTING',
      'from=results',
      'from=',
      'from=reporting%20',
      'view=reports',
      '',
    ]) {
      expect(parseIncidentOrigin(new URLSearchParams(query)), query).toBeNull();
    }
    expect(parseIncidentOrigin(null)).toBeNull();
    expect(parseIncidentOrigin(undefined)).toBeNull();
  });

  it('reads only the first of repeated values', () => {
    expect(parseIncidentOrigin(new URLSearchParams('from=reporting&from=x'))).toBe('reporting');
    expect(parseIncidentOrigin(new URLSearchParams('from=x&from=reporting'))).toBeNull();
  });
});

describe('incidentBackLink (BR2.3)', () => {
  it('goes back to Incident Reports from the list, otherwise to the results page', () => {
    expect(incidentBackLink('reporting', '/results/42?season=atc-18')).toEqual({
      label: '← Back to Incident Reports',
      href: '/admin/incident-reporting',
    });
    expect(incidentBackLink(null, '/results/42?season=atc-18')).toEqual({
      label: '← Back to Results',
      href: '/results/42?season=atc-18',
    });
  });
});

describe('withIncidentOrigin (BR2.5)', () => {
  it('adds the marker and keeps the other parameters and the hash', () => {
    expect(withIncidentOrigin('/results/42/incidents?view=reports', 'reporting')).toBe(
      '/results/42/incidents?view=reports&from=reporting',
    );
    expect(withIncidentOrigin('?view=reports&filter=open#report-3', 'reporting')).toBe(
      '?view=reports&filter=open&from=reporting#report-3',
    );
    expect(withIncidentOrigin('/results/42/incidents', 'reporting')).toBe(
      '/results/42/incidents?from=reporting',
    );
    // Already there: set once, not twice.
    expect(withIncidentOrigin('?from=reporting&view=reports', 'reporting')).toBe(
      '?from=reporting&view=reports',
    );
  });

  it('leaves the link unchanged with no origin', () => {
    expect(withIncidentOrigin('/results/42/incidents?view=reports#x', null)).toBe(
      '/results/42/incidents?view=reports#x',
    );
  });
});
