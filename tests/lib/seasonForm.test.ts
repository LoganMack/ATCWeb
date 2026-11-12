/**
 * Admin > Seasons "New season" form (FR10.1-FR10.3; BR10.2, BR10.4): the pre-filled values and each server
 * check, with the entered values kept on error.
 */
import { describe, expect, it } from 'vitest';
import { DUPLICATE_SEASON_MESSAGE, newSeasonDefaults, parseNewSeasonForm } from '../../src/lib/seasonForm';
import { createSeasonFailure } from '../../src/lib/db/seasons';

const RULESETS = [
  { id: 'rules-old', is_default: false },
  { id: 'rules-default', is_default: true },
];
const existing = { seasonNumbers: [17, 18, 19], rulesetIds: RULESETS.map((r) => r.id) };

function form(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

const valid = { number: '20', name: 'ATC20', scoring_ruleset_id: 'rules-default' };

describe('newSeasonDefaults (BR10.4)', () => {
  it('pre-fills the next number, its name, the default ruleset and every switch off', () => {
    expect(newSeasonDefaults([{ number: 19 }, { number: 17 }], RULESETS)).toEqual({
      number: '20',
      name: 'ATC20',
      rulesetId: 'rules-default',
      gamma: false,
      delta: false,
      deltaTeam: false,
    });
  });

  it('starts at 1 with no seasons, and takes the first ruleset when none is the default', () => {
    const defaults = newSeasonDefaults([], [{ id: 'only', is_default: false }]);
    expect(defaults.number).toBe('1');
    expect(defaults.name).toBe('ATC1');
    expect(defaults.rulesetId).toBe('only');
  });
});

describe('parseNewSeasonForm (BR10.2)', () => {
  it('accepts a valid form and reads the switches', () => {
    const result = parseNewSeasonForm(
      form({ ...valid, gamma_enabled: 'on', delta_team_enabled: 'on' }),
      existing,
    );
    expect(result).toEqual({
      ok: true,
      input: {
        number: 20,
        name: 'ATC20',
        scoring_ruleset_id: 'rules-default',
        gamma_enabled: true,
        delta_enabled: false,
        delta_team_enabled: true,
      },
    });
  });

  it('refuses a number that is taken, keeping what was entered', () => {
    const result = parseNewSeasonForm(form({ ...valid, number: '19', name: 'ATC19' }), existing);
    expect(result).toMatchObject({ ok: false, error: DUPLICATE_SEASON_MESSAGE, values: { number: '19' } });
  });

  it('refuses a number that is not a whole number of 1 or more', () => {
    for (const number of ['0', '-3', '2.5', 'abc', '']) {
      expect(parseNewSeasonForm(form({ ...valid, number }), existing)).toMatchObject({ ok: false });
    }
  });

  it('refuses a blank name and one that does not match the number', () => {
    expect(parseNewSeasonForm(form({ ...valid, name: '  ' }), existing)).toMatchObject({
      ok: false,
      error: 'Name is required.',
    });
    expect(parseNewSeasonForm(form({ ...valid, name: 'ATC21' }), existing)).toMatchObject({
      ok: false,
      error: 'Name must be ATC20 to match the number.',
    });
  });

  it('refuses a ruleset that does not exist', () => {
    expect(parseNewSeasonForm(form({ ...valid, scoring_ruleset_id: 'nope' }), existing)).toMatchObject({
      ok: false,
      error: 'Choose a ruleset.',
    });
  });
});

describe('createSeasonFailure', () => {
  it('maps the database errors to their reasons', () => {
    expect(createSeasonFailure('Supabase insert error 409 on seasons: {"code":"23505"}')).toBe('duplicate');
    expect(
      createSeasonFailure('Supabase insert error 403 on seasons: new row violates row-level security policy'),
    ).toBe('forbidden');
    expect(createSeasonFailure('Supabase insert error 500 on seasons: boom')).toBe('failed');
  });
});
