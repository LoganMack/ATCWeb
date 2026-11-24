/**
 * Round eligibility (src/lib/results/roundEligibility.ts; round-eligibility BR1.1-BR1.6, NFR3.2): test and
 * exhibition rounds are excluded by override flags or event category, and the module stays pure.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_EVENT_CATEGORIES,
  ROUND_EVENT_CATEGORY_SELECT,
  excludedRoundIds,
  isExcludedRound,
  toEligibilityRound,
} from '../../src/lib/results/roundEligibility';

const round = (id: number, category: string | null = null) => ({ subsession_id: id, event_category: category });
const none = new Set<number>();

describe('isExcludedRound (BR1.1-BR1.3)', () => {
  it('excludes on the override alone, the category alone, or both', () => {
    expect(isExcludedRound(round(1), new Set([1]))).toBe(true);
    expect(isExcludedRound(round(1, 'test'), none)).toBe(true);
    expect(isExcludedRound(round(1, 'exhibition'), none)).toBe(true);
    expect(isExcludedRound(round(1, 'test'), new Set([1]))).toBe(true);
  });

  it('keeps a round with neither, including one with no event', () => {
    expect(isExcludedRound(round(1, 'championship'), new Set([2]))).toBe(false);
    expect(isExcludedRound(round(1), none)).toBe(false);
  });

  it('only test and exhibition exclude, ignoring case and spaces', () => {
    expect(EXCLUDED_EVENT_CATEGORIES).toEqual(['test', 'exhibition']);
    for (const c of ['championship', 'holiday', 'iracing', 'something-new', '']) {
      expect(isExcludedRound(round(1, c), none), c).toBe(false);
    }
    expect(isExcludedRound(round(1, ' Test '), none)).toBe(true);
    expect(isExcludedRound(round(1, 'EXHIBITION'), none)).toBe(true);
  });
});

describe('excludedRoundIds (BR1.6)', () => {
  it('returns an empty set for no rounds', () => {
    expect(excludedRoundIds([], new Set([1]))).toEqual(new Set());
  });

  it('returns only ids from the given rounds, once each', () => {
    const rounds = [round(1, 'test'), round(1, 'test'), round(2), round(3, 'exhibition'), round(4)];
    expect(excludedRoundIds(rounds, new Set([4, 99]))).toEqual(new Set([1, 3, 4]));
  });

  it('does not change its inputs and returns a new set', () => {
    const rounds = Object.freeze([Object.freeze(round(1, 'test')), Object.freeze(round(2))]);
    const overrides = new Set([2]);
    const result = excludedRoundIds(rounds, overrides);
    expect(result).not.toBe(overrides);
    expect(overrides).toEqual(new Set([2]));
    expect(result).toEqual(new Set([1, 2]));
  });
});

describe('toEligibilityRound (BR1.4)', () => {
  it('reads real row shapes: the linked event is an object, pinned events an array', () => {
    const row = { subsession_id: 7, event: { category: 'championship' }, pinned_events: [{ category: 'test' }] };
    expect(toEligibilityRound(row)).toEqual({ subsession_id: 7, event_category: 'championship' });
  });

  it('falls back to a pinned event when no event is linked', () => {
    expect(toEligibilityRound({ subsession_id: 7, event: null, pinned_events: [{ category: 'test' }] })).toEqual(
      round(7, 'test'),
    );
  });

  it('prefers an excluded pinned category over an earlier one', () => {
    const row = {
      subsession_id: 7,
      event: null,
      pinned_events: [{ category: 'championship' }, { category: 'exhibition' }],
    };
    expect(toEligibilityRound(row).event_category).toBe('exhibition');
    expect(
      toEligibilityRound({ subsession_id: 7, event: null, pinned_events: [{ category: 'holiday' }] })
        .event_category,
    ).toBe('holiday');
  });

  it('gives no category when there is no event at all', () => {
    expect(toEligibilityRound({ subsession_id: 7, event: null, pinned_events: null })).toEqual(round(7));
    expect(toEligibilityRound({ subsession_id: 7, event: null, pinned_events: [] })).toEqual(round(7));
    expect(toEligibilityRound({ subsession_id: 7 })).toEqual(round(7));
  });

  it('treats a non-array pinned_events as empty', () => {
    const row = { subsession_id: 7, event: null, pinned_events: { category: 'test' } } as never;
    expect(toEligibilityRound(row)).toEqual(round(7));
  });
});

describe('the embed and the module source (BR1.5, NFR3.2)', () => {
  it('names both foreign keys in the embed', () => {
    expect(ROUND_EVENT_CATEGORY_SELECT).toBe(
      'event:events!curated_rounds_event_id_fkey(category),pinned_events:events!events_subsession_id_fkey(category)',
    );
  });

  it('imports nothing from src/lib/db and does no I/O', () => {
    const src = readFileSync('src/lib/results/roundEligibility.ts', 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*\/db\//);
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
