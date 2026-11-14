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

/** The name for what is in the Number box: "ATC" + a whole number of 1 or more, else blank. */
export function nameForNumberInput(value: string): string {
  const text = value.trim();
  if (!/^\d{1,6}$/.test(text)) return '';
  const number = Number(text);
  return number >= 1 ? seasonNameFor(number) : '';
}

const ATC_NAME = /^ATC(\d+)$/;

/**
 * The suggested number (FR1.1): the first unused number above the current season when it is an ATC season,
 * else above the highest ATC season. Other series (LCC1, Exhibitions) use large iRacing numbers, so they never
 * set the starting point.
 */
export function nextSeasonNumber(seasons: { number: number; name: string; is_current?: boolean }[]): number {
  const isAtc = (s: { number: number; name: string }) =>
    ATC_NAME.exec(s.name.trim())?.[1] === String(s.number);
  const current = seasons.find((s) => s.is_current && isAtc(s));
  let next = (current?.number ?? seasons.filter(isAtc).reduce((max, s) => Math.max(max, s.number), 0)) + 1;
  const taken = new Set(seasons.map((s) => s.number));
  while (taken.has(next)) next++;
  return next;
}

/** The suggested number, its name, the default ruleset and every switch off. */
export function newSeasonDefaults(
  seasons: { number: number; name: string; is_current?: boolean }[],
  rulesets: { id: string; is_default: boolean }[],
): NewSeasonValues {
  const next = nextSeasonNumber(seasons);
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
 * Reads and checks the form (BR10.2): a whole number of 1 or more not used by another season, an existing
 * ruleset and on/off switches. The name is "ATC" + the number. On error the entered values come back so the
 * form can show them again.
 */
export function parseNewSeasonForm(
  form: FormLike,
  existing: { seasonNumbers: number[]; rulesetIds: string[] },
): NewSeasonResult {
  const values: NewSeasonValues = {
    number: String(form.get('number') ?? '').trim(),
    name: '',
    rulesetId: String(form.get('scoring_ruleset_id') ?? '').trim(),
    gamma: isOn(form, 'gamma_enabled'),
    delta: isOn(form, 'delta_enabled'),
    deltaTeam: isOn(form, 'delta_team_enabled'),
  };
  const fail = (error: string): NewSeasonResult => ({ ok: false, error, values });

  const number = /^\d{1,6}$/.test(values.number) ? Number(values.number) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) return fail('Number must be a whole number of 1 or more.');
  // The name is never typed (FR1.3): it is always built from the number, whatever the form sent.
  values.name = seasonNameFor(number);
  if (existing.seasonNumbers.includes(number)) return fail(DUPLICATE_SEASON_MESSAGE);
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

/** What a season row's Save changed, for the activity log (FR3.7), e.g. "Dark logo, light logo, ruleset, class settings (Gamma: on, Delta: off, Delta Team: off)". */
export function seasonRowSaveSummary(change: {
  darkLogo: boolean;
  lightLogo: boolean;
  rulesetChanged: boolean;
  flags: { gamma_enabled: boolean; delta_enabled: boolean; delta_team_enabled: boolean } | null;
}): string {
  const onOff = (v: boolean) => (v ? 'on' : 'off');
  const parts: string[] = [];
  if (change.darkLogo) parts.push('dark logo');
  if (change.lightLogo) parts.push('light logo');
  if (change.rulesetChanged) parts.push('ruleset');
  if (change.flags) {
    const f = change.flags;
    parts.push(
      `class settings (Gamma: ${onOff(f.gamma_enabled)}, Delta: ${onOff(f.delta_enabled)}, Delta Team: ${onOff(f.delta_team_enabled)})`,
    );
  }
  if (parts.length === 0) return 'No changes';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
