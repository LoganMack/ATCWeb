import { describe, expect, it } from 'vitest';

describe('test runner guards', () => {
  it('blocks the network', () => {
    expect(() => fetch('https://example.com')).toThrow('network is blocked in tests');
  });

  it('runs in UTC', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0);
  });
});
