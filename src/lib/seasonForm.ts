/**
 * Admin > Seasons "New season" form (FR10.1-FR10.3; BR10.2, BR10.4): the pre-filled values and the server-side
 * checks. The database insert policy still decides who may create a season (BR10.1).
 */
import type { NewSeasonInput } from './db/seasons';

export interface NewSeasonValues {
  number: string;
  name: string;
  rulesetId: string;
  gamma: boolean;
  delta: boolean;
  deltaTeam: boolean;
}

export const DUPLICATE_SEASON_MESSAGE = 'That season number already exists';

/** The championship name for a season number: "ATC" + number. */
export function seasonNameFor(number: number): string {
  return `ATC${number}`;
}

/** Highest season number + 1 (1 when there is none), its name, the default ruleset and every switch off. */
export function newSeasonDefaults(
  seasons: { number: number }[],
  rulesets: { id: string; is_default: boolean }[],
): NewSeasonValues {
  const next = seasons.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  return {
    number: String(next),
    name: seasonNameFor(next),
    rulesetId: (rulesets.find((r) => r.is_default) ?? rulesets[0])?.id ?? '',
    gamma: false,
    delta: false,
    deltaTeam: false,
  };
}

type FormLike = { get(name: string): FormDataEntryValue | null };

const isOn = (form: FormLike, name: string) => {
  const value = String(form.get(name) ?? '');
  return value === 'on' || value === 'true';
};

export type NewSeasonResult =
  { ok: true; input: NewSeasonInput } | { ok: false; error: string; values: NewSeasonValues };

/**
 * Reads and checks the form (BR10.2): a whole number of 1 or more not used by another season, a name that is
 * "ATC" + the number, an existing ruleset and on/off switches. On error the entered values come back so the
 * form can show them again.
 */
export function parseNewSeasonForm(
  form: FormLike,
  existing: { seasonNumbers: number[]; rulesetIds: string[] },
): NewSeasonResult {
  const values: NewSeasonValues = {
    number: String(form.get('number') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    rulesetId: String(form.get('scoring_ruleset_id') ?? '').trim(),
    gamma: isOn(form, 'gamma_enabled'),
    delta: isOn(form, 'delta_enabled'),
    deltaTeam: isOn(form, 'delta_team_enabled'),
  };
  const fail = (error: string): NewSeasonResult => ({ ok: false, error, values });

  const number = /^\d{1,6}$/.test(values.number) ? Number(values.number) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) return fail('Number must be a whole number of 1 or more.');
  if (existing.seasonNumbers.includes(number)) return fail(DUPLICATE_SEASON_MESSAGE);
  if (values.name === '') return fail('Name is required.');
  if (values.name !== seasonNameFor(number))
    return fail(`Name must be ${seasonNameFor(number)} to match the number.`);
  if (!existing.rulesetIds.includes(values.rulesetId)) return fail('Choose a ruleset.');

  return {
    ok: true,
    input: {
      number,
      name: values.name,
      scoring_ruleset_id: values.rulesetId,
      gamma_enabled: values.gamma,
      delta_enabled: values.delta,
      delta_team_enabled: values.deltaTeam,
    },
  };
}
