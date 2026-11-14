/**
 * Admin > Seasons "New season" form (FR10.1-FR10.3; BR10.2, BR10.4): the pre-filled values and each server
 * check, with the entered values kept on error.
 */
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_SEASON_MESSAGE,
  nameForNumberInput,
  newSeasonDefaults,
  nextSeasonNumber,
  parseNewSeasonForm,
  seasonRowSaveSummary,
} from '../../src/lib/seasonForm';
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

// Production on 2026-11-14: ATC18 current, ATC19 created, and other series stored with large iRacing numbers.
const PRODUCTION = [
  { number: 1089703, name: 'LCC1', is_current: false },
  { number: 1080303, name: 'ATC4 Off-Season Fun Series', is_current: false },
  { number: 114731, name: 'ATC Exhibitions', is_current: false },
  { number: 19, name: 'ATC19', is_current: false },
  { number: 18, name: 'ATC18', is_current: true },
  { number: 17, name: 'ATC17', is_current: false },
];

describe('nextSeasonNumber (FR1.1)', () => {
  it('suggests 20, not 1089704: the next free number after the current ATC season', () => {
    expect(nextSeasonNumber(PRODUCTION)).toBe(20);
  });

  it('counts only ATC seasons when none is current', () => {
    expect(nextSeasonNumber(PRODUCTION.map((s) => ({ ...s, is_current: false })))).toBe(20);
  });

  it('counts only ATC seasons when another series is current', () => {
    expect(nextSeasonNumber(PRODUCTION.map((s) => ({ ...s, is_current: s.name === 'LCC1' })))).toBe(20);
  });

  it('starts at 1 with no ATC seasons', () => {
    expect(nextSeasonNumber([])).toBe(1);
    expect(nextSeasonNumber([{ number: 1089703, name: 'LCC1', is_current: true }])).toBe(1);
  });

  it('skips a number already taken by another series', () => {
    expect(
      nextSeasonNumber([
        { number: 18, name: 'ATC18', is_current: true },
        { number: 19, name: 'Something else' },
      ]),
    ).toBe(20);
  });
});

describe('newSeasonDefaults (BR10.4)', () => {
  it('pre-fills the next number, its name, the default ruleset and every switch off', () => {
    expect(newSeasonDefaults(PRODUCTION, RULESETS)).toEqual({
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

  it('ignores a submitted name and builds it from the number (FR1.3)', () => {
    for (const name of ['  ', 'ATC21', 'Anything']) {
      expect(parseNewSeasonForm(form({ ...valid, name }), existing)).toMatchObject({
        ok: true,
        input: { number: 20, name: 'ATC20' },
      });
    }
    expect(
      parseNewSeasonForm(form({ number: '20', scoring_ruleset_id: 'rules-default' }), existing),
    ).toMatchObject({
      ok: true,
      input: { name: 'ATC20' },
    });
  });

  it('shows the derived name with a refused number', () => {
    const result = parseNewSeasonForm(form({ ...valid, number: '19', name: 'typed' }), existing);
    expect(result).toMatchObject({ ok: false, values: { number: '19', name: 'ATC19' } });
  });

  it('refuses a ruleset that does not exist', () => {
    expect(parseNewSeasonForm(form({ ...valid, scoring_ruleset_id: 'nope' }), existing)).toMatchObject({
      ok: false,
      error: 'Choose a ruleset.',
    });
  });
});

describe('nameForNumberInput (FR1.2)', () => {
  it('follows the number as it is typed, and is blank for anything else', () => {
    expect(nameForNumberInput('20')).toBe('ATC20');
    expect(nameForNumberInput(' 7 ')).toBe('ATC7');
    for (const value of ['', '0', '-1', '2.5', 'abc']) expect(nameForNumberInput(value)).toBe('');
  });
});

describe('seasonRowSaveSummary (FR3.7)', () => {
  it('names each part of the row that changed', () => {
    expect(
      seasonRowSaveSummary({
        darkLogo: true,
        lightLogo: false,
        rulesetChanged: true,
        flags: { gamma_enabled: true, delta_enabled: false, delta_team_enabled: false },
      }),
    ).toBe('Dark logo, ruleset, class settings (Gamma: on, Delta: off, Delta Team: off)');
    expect(
      seasonRowSaveSummary({ darkLogo: false, lightLogo: true, rulesetChanged: false, flags: null }),
    ).toBe('Light logo');
    expect(
      seasonRowSaveSummary({ darkLogo: false, lightLogo: false, rulesetChanged: false, flags: null }),
    ).toBe('No changes');
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
