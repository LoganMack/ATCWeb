import { describe, expect, it } from 'vitest';
import { formatDateShort } from '../../src/lib/db/circuits';

// Pins the text the roster and incident tables show, since the formatter is now a shared Intl instance.
describe('formatDateShort', () => {
  it('formats a date-only value on that calendar day', () => {
    expect(formatDateShort('2026-11-03')).toBe('Nov 3, 2026');
    expect(formatDateShort('2025-01-31')).toBe('Jan 31, 2025');
  });

  it('formats an ISO timestamp', () => {
    expect(formatDateShort('2026-11-03T20:00:00Z')).toBe('Nov 3, 2026');
  });

  it('gives an em dash for no date', () => {
    expect(formatDateShort(null)).toBe('—');
    expect(formatDateShort('')).toBe('—');
  });

  it('gives "Invalid Date" for a bad value, as toLocaleDateString did', () => {
    expect(formatDateShort('not a date')).toBe('Invalid Date');
    expect(formatDateShort('2026-13-45T99:00')).toBe('Invalid Date');
  });

  it('matches toLocaleDateString for the same options', () => {
    const opts = { month: 'short', day: 'numeric', year: 'numeric' } as const;
    for (const iso of ['2024-02-29T12:00:00Z', '2026-07-04T00:00:00Z', '2023-12-31T23:59:59Z']) {
      expect(formatDateShort(iso)).toBe(new Date(iso).toLocaleDateString('en-US', opts));
    }
  });
});
