import { describe, expect, it } from 'vitest';
import { rulesetBaseDropWeeks, seasonDropWeeks } from '../../src/lib/results';
import type { ScoringRuleset } from '../../src/lib/db/seasons';

function ruleset(id: string, rules: unknown, isDefault = false): ScoringRuleset {
  return {
    id,
    name: id,
    rules,
    is_default: isDefault,
    can_drop_final_round: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('rulesetBaseDropWeeks', () => {
  it('reads drops.base from the ruleset', () => {
    expect(rulesetBaseDropWeeks(ruleset('r', { drops: { base: 3 } }))).toBe(3);
  });

  it('gives 2 when there is no ruleset', () => {
    expect(rulesetBaseDropWeeks(null)).toBe(2);
    expect(rulesetBaseDropWeeks(undefined)).toBe(2);
  });

  it('gives 2 when drops.base is missing, not a whole number, or negative', () => {
    expect(rulesetBaseDropWeeks(ruleset('r', {}))).toBe(2);
    expect(rulesetBaseDropWeeks(ruleset('r', { drops: { base: 1.5 } }))).toBe(2);
    expect(rulesetBaseDropWeeks(ruleset('r', { drops: { base: '3' } }))).toBe(2);
    expect(rulesetBaseDropWeeks(ruleset('r', { drops: { base: -1 } }))).toBe(2);
  });

  it('allows a base of 0', () => {
    expect(rulesetBaseDropWeeks(ruleset('r', { drops: { base: 0 } }))).toBe(0);
  });
});

describe('seasonDropWeeks', () => {
  const rulesets = [ruleset('r3', { drops: { base: 3 } }), ruleset('r1', { drops: { base: 1 } })];

  it('gives the base when extra_drop_weeks is null', () => {
    // The column is NOT NULL, but the function guards against a null anyway; this pins that guard.
    const extra = null as unknown as number;
    expect(seasonDropWeeks({ scoring_ruleset_id: 'r3', extra_drop_weeks: extra }, rulesets)).toBe(3);
  });

  it('adds extra_drop_weeks to the base', () => {
    expect(seasonDropWeeks({ scoring_ruleset_id: 'r3', extra_drop_weeks: 1 }, rulesets)).toBe(4);
    expect(seasonDropWeeks({ scoring_ruleset_id: 'r1', extra_drop_weeks: 2 }, rulesets)).toBe(3);
  });

  it('gives 2 + extra when the season’s ruleset is not found and there is no default', () => {
    expect(seasonDropWeeks({ scoring_ruleset_id: 'missing', extra_drop_weeks: 1 }, rulesets)).toBe(3);
    expect(seasonDropWeeks({ scoring_ruleset_id: null, extra_drop_weeks: 0 }, rulesets)).toBe(2);
  });

  it('falls back to the default ruleset when the season has none', () => {
    const withDefault = [...rulesets, ruleset('d', { drops: { base: 4 } }, true)];
    expect(seasonDropWeeks({ scoring_ruleset_id: null, extra_drop_weeks: 1 }, withDefault)).toBe(5);
  });
});
