/**
 * The appeal popups' checks (src/scripts/appealDialogs.ts; appeals BR2.2, BR3.1): the character counter counts
 * as the database does, and Save stays disabled until the values would pass the server's checks.
 */
import { describe, expect, it } from 'vitest';
import { appealTextProblem, closeAppealProblem, counterText, textLength } from '../../src/scripts/appealDialogs';
import { parseCloseAppealForm } from '../../src/lib/appealClose';

const ok = { time: '2.5', points: '0', licence: '1', comment: 'Reduced.' };

describe('the comment counter', () => {
  it('counts an emoji once, as char_length does', () => {
    expect(textLength('\u{1F3C1}ab')).toBe(3);
    expect(counterText('abc')).toBe('3 / 4,000');
    expect(counterText('')).toBe('0 / 4,000');
  });
});

describe('appealTextProblem (BR2.2)', () => {
  it('needs 1 to 4,000 characters after trimming', () => {
    expect(appealTextProblem('  ')).toBe('Write a comment first.');
    expect(appealTextProblem('x'.repeat(4001))).toBe('A comment can be at most 4,000 characters.');
    expect(appealTextProblem(` ${'x'.repeat(4000)} `)).toBeNull();
  });
});

describe('closeAppealProblem (BR3.1)', () => {
  it('accepts whole points, a time with up to 3 decimals and a comment', () => {
    expect(closeAppealProblem(ok)).toBeNull();
    expect(closeAppealProblem({ ...ok, time: '0' })).toBeNull();
    expect(closeAppealProblem({ ...ok, time: '1.125' })).toBeNull();
  });

  it.each([
    [{ time: '-1' }, /time penalty/],
    [{ time: '1.2345' }, /3 decimals/],
    [{ time: '' }, /time penalty/],
    [{ points: '1.5' }, /points penalty/],
    [{ licence: '-2' }, /Penalty points/],
    [{ comment: '   ' }, /comment/],
  ])('refuses %o', (change, message) => {
    expect(closeAppealProblem({ ...ok, ...change })).toMatch(message);
  });

  it('agrees with the server check on the same values', () => {
    for (const values of [ok, { ...ok, time: '1.2345' }, { ...ok, points: 'x' }, { ...ok, comment: ' ' }]) {
      const form = new FormData();
      form.set('appeal_id', 'dddddddd-1111-4222-8333-444444444444');
      form.set('time_penalty_seconds', values.time);
      form.set('points_penalty', values.points);
      form.set('penalty_points', values.licence);
      form.set('comment', values.comment);
      expect(parseCloseAppealForm(form).ok).toBe(closeAppealProblem(values) === null);
    }
  });
});
