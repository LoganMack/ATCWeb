/**
 * The poll save size limit (src/lib/polls/requestSize.ts; polls BR4.1): the server refuses a missing or
 * oversized Content-Length before parsing, and the editor refuses images that would not fit.
 */
import { describe, expect, it } from 'vitest';
import {
  POLL_SAVE_MAX_BYTES,
  POLL_SAVE_TEXT_ALLOWANCE,
  formatMegabytes,
  pollImagesBudgetMessage,
  pollSaveSizeError,
} from '../../src/lib/polls/requestSize';

describe('pollSaveSizeError', () => {
  it('lets a body at or under the limit through', () => {
    expect(POLL_SAVE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(pollSaveSizeError('0')).toBeNull();
    expect(pollSaveSizeError(String(POLL_SAVE_MAX_BYTES))).toBeNull();
    expect(pollSaveSizeError(' 1024 ')).toBeNull();
  });

  it('refuses a body over the limit with its size and the limit', () => {
    const err = pollSaveSizeError(String(30 * 1024 * 1024))!;
    expect(err.field).toBe('form');
    expect(err.message).toContain('30.0 MB');
    expect(err.message).toContain('8.0 MB limit');
    expect(pollSaveSizeError(String(POLL_SAVE_MAX_BYTES + 1))).not.toBeNull();
  });

  it('refuses a missing or malformed length', () => {
    for (const value of [null, '', 'abc', '-5', '1e9', '12.5']) {
      expect(pollSaveSizeError(value)?.message, String(value)).toContain('size was not sent');
    }
  });
});

describe('pollImagesBudgetMessage', () => {
  const budget = POLL_SAVE_MAX_BYTES - POLL_SAVE_TEXT_ALLOWANCE;

  it('accepts images up to the limit less the room kept for text', () => {
    expect(pollImagesBudgetMessage(0)).toBeNull();
    expect(pollImagesBudgetMessage(budget)).toBeNull();
  });

  it('explains how to split a save that is too large', () => {
    const message = pollImagesBudgetMessage(budget + 1)!;
    expect(message).toContain(formatMegabytes(budget));
    expect(message).toContain('second save');
  });
});
