/**
 * formatCpi (contract C4): the Corners per Incident text on the standings and the race header.
 */
import { describe, expect, it } from 'vitest';
import { CPI_DASH, formatCpi } from '../../src/lib/results/cpi';

describe('formatCpi', () => {
  it('shows a dash when the corners are unknown', () => {
    expect(formatCpi(null, 4)).toBe(CPI_DASH);
    expect(formatCpi(undefined, 4)).toBe(CPI_DASH);
  });

  it('shows a dash when there were no incidents', () => {
    expect(formatCpi(1200, 0)).toBe(CPI_DASH);
  });

  it('shows 0.0 when corners are known but zero', () => {
    expect(formatCpi(0, 3)).toBe('0.0');
  });

  it('rounds to one decimal place', () => {
    expect(formatCpi(1234, 7)).toBe('176.3');
    expect(formatCpi(100, 3)).toBe('33.3');
  });

  it('keeps a trailing .0 on whole results', () => {
    expect(formatCpi(300, 3)).toBe('100.0');
  });

  it('handles large season totals', () => {
    expect(formatCpi(98765, 2)).toBe('49382.5');
  });

  it('treats a non-finite corner count as unknown', () => {
    expect(formatCpi(Number.NaN, 2)).toBe(CPI_DASH);
  });
});
