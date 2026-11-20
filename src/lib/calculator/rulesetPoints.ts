/**
 * Points tables and best cases for the points calculator, read from a season's scoring ruleset (BR3.4, BR3.5,
 * BR3.8, BR3.10). The database's score_round() is the scorer; these mirror its table choice
 * (private.scoring_finish_points and private.scoring_class_points in 20261021120000_race_score_results_expand.sql)
 * so a reader's edit or a projected round prices points the same way. Browser-safe: no server imports.
 */

export type ScoredFormat = 'sprint' | 'endurance';

/** Which points a championship counts: overall totals, or class totals for one class (Gamma, Delta). */
export interface PointsBasis {
  /** The class whose podium points count, or null for overall totals (Overall, Alpha, Alpha Team). */
  className: string | null;
}

/** One race's tables: finish points by overall position and class points by class position. */
export interface RaceTable {
  finish: number[];
  /** Points for a classified position past the end of `finish` (the site's rule). */
  classifiedMinimum: number;
  /** Empty unless the championship counts class points and the ruleset awards them to that class. */
  classPoints: number[];
}

/** What one driver (or a team's two counting drivers) can earn in one round. */
export interface RoundCaps {
  /** Per race, in race order. */
  races: RaceTable[];
  /** BR3.4: one driver's best case. */
  bestCase: number;
  /** BR3.8: the best case less the smallest one-place slip (P2 instead of P1) in one race. */
  secondPlaceCase: number;
  /** BR3.5: two counting drivers P1 and P2 in every race, each with every bonus. */
  teamBestCase: number;
  /** BR3.8: the team best case less the smallest P2-to-P3 slip in one race. */
  teamSecondPlaceCase: number;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function int(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
}

function intArray(value: unknown): number[] | null {
  return Array.isArray(value) ? value.map(int) : null;
}

/**
 * The finish points table for one race, chosen as the database chooses it: a round in the ruleset's
 * race_overrides uses the override table for that race number; sprint races 2 and 3 use their own tables when
 * the ruleset has them; otherwise the format's table.
 */
export function raceFinishTable(
  rules: unknown,
  format: ScoredFormat,
  raceNumber: number,
  override: boolean,
): { finish: number[]; classifiedMinimum: number } {
  const r = obj(rules);
  const base = obj(r.base_points);
  const overrides = obj(r.race_overrides);
  const key = String(raceNumber);
  let finish: number[] | null = null;
  if (override) finish = intArray(obj(overrides.base_points)[key]);
  if (!finish && format === 'sprint' && raceNumber === 3) finish = intArray(base.sprint_race3);
  if (!finish && format === 'sprint' && raceNumber > 1) finish = intArray(base.sprint_race2);
  if (!finish) finish = intArray(base[format]) ?? [];
  const overrideMinimum = override ? obj(overrides.classified_minimum)[key] : undefined;
  const classifiedMinimum = int(overrideMinimum ?? obj(r.classified_minimum)[format]);
  return { finish, classifiedMinimum };
}

/** Class podium points for one race, or [] when the ruleset gives this class none. */
export function raceClassTable(
  rules: unknown,
  format: ScoredFormat,
  raceNumber: number,
  className: string | null,
): number[] {
  if (!className) return [];
  const podium = obj(obj(rules).class_podium);
  const appliesTo = Array.isArray(podium.applies_to) ? podium.applies_to : [];
  if (!appliesTo.includes(className)) return [];
  let table: number[] | null = null;
  if (format === 'sprint' && raceNumber === 3) table = intArray(podium.sprint_race3);
  if (!table && format === 'sprint' && raceNumber > 1) table = intArray(podium.sprint_race2);
  return table ?? intArray(podium[format]) ?? [];
}

/** Finish points for a 1-based overall position; past the table, the classified minimum. */
export function finishPointsAt(table: RaceTable, position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return position <= table.finish.length ? table.finish[position - 1] : table.classifiedMinimum;
}

/** Class points for a 1-based class position (0 past the podium table). */
export function classPointsAt(table: RaceTable, position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return table.classPoints[position - 1] ?? 0;
}

/** BR3.10 position mode: one race's points for a finishing position (finish points plus any class points). */
export function racePointsAt(table: RaceTable, position: number): number {
  return finishPointsAt(table, position) + classPointsAt(table, position);
}

/** BR3.10 position mode for a whole round: the same position in every race; null (did not race) is 0. */
export function roundPointsAt(races: readonly RaceTable[], position: number | null): number {
  if (position === null) return 0;
  return races.reduce((sum, table) => sum + racePointsAt(table, position), 0);
}

function bonusEnabled(bonus: Json): boolean {
  return bonus.enabled === true || bonus.enabled === 'true';
}

/**
 * Every bonus one driver can earn in a round (BR3.4), as per-race amounts plus a once-per-round amount.
 * Per-race: Sublime Finesse, Naked Aggression, lap led, and fewest incidents and fastest lap when they are
 * per race. Once per round: class pole, fewest incidents and fastest lap when they are per round, and the
 * sprint sweep in sprint rounds of more than one race.
 */
export function bonusCaps(
  rules: unknown,
  format: ScoredFormat,
  races: number,
): { perRace: number; perRound: number } {
  const bonuses = obj(obj(rules).bonuses);
  let perRace = 0;
  let perRound = 0;
  for (const name of ['sublime_finesse', 'naked_aggression', 'lap_led']) {
    const b = obj(bonuses[name]);
    if (bonusEnabled(b)) perRace += int(b[format]);
  }
  for (const name of ['fewest_incidents', 'fastest_lap']) {
    const b = obj(bonuses[name]);
    if (!bonusEnabled(b) || int(b.top_x) <= 0) continue;
    if (b.per === 'round') perRound += int(b[format]);
    else perRace += int(b[format]);
  }
  const pole = obj(bonuses.class_pole);
  if (bonusEnabled(pole)) perRound += int(pole[format]);
  const sweep = obj(bonuses.sprint_sweep);
  if (bonusEnabled(sweep) && format === 'sprint' && races > 1) perRound += int(sweep.points);
  return { perRace, perRound };
}

/**
 * The tables and caps of one scored round (BR3.4, BR3.5, BR3.8). `override` is true only for a run round the
 * ruleset lists in race_overrides.subsession_ids; a future round has no subsession id yet.
 */
export function roundCaps(
  rules: unknown,
  format: ScoredFormat,
  raceCount: number,
  basis: PointsBasis,
  override = false,
): RoundCaps {
  const races: RaceTable[] = [];
  for (let n = 1; n <= raceCount; n++) {
    races.push({
      ...raceFinishTable(rules, format, n, override),
      classPoints: raceClassTable(rules, format, n, basis.className),
    });
  }
  const { perRace, perRound } = bonusCaps(rules, format, raceCount);
  const bonus = perRace * raceCount + perRound;
  const p = (table: RaceTable, position: number) => racePointsAt(table, position);

  const bestCase = races.reduce((sum, t) => sum + p(t, 1), 0) + bonus;
  const slips = races.map((t) => p(t, 1) - p(t, 2));
  const secondPlaceCase = bestCase - (slips.length ? Math.min(...slips) : 0);

  const teamBestCase = races.reduce((sum, t) => sum + p(t, 1) + p(t, 2), 0) + 2 * bonus;
  const teamSlips = races.map((t) => p(t, 2) - p(t, 3));
  const teamSecondPlaceCase = teamBestCase - (teamSlips.length ? Math.min(...teamSlips) : 0);

  return { races, bestCase, secondPlaceCase, teamBestCase, teamSecondPlaceCase };
}

/** Whether a run round uses the ruleset's race_overrides tables. */
export function isOverrideRound(rules: unknown, subsessionId: number | null): boolean {
  if (subsessionId === null) return false;
  const ids = obj(obj(rules).race_overrides).subsession_ids;
  return Array.isArray(ids) && ids.some((id) => String(id) === String(subsessionId));
}
