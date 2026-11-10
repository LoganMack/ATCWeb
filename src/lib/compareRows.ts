/**
 * The Compare view's pure helpers (BR4.4, BR4.9-BR4.11; FR3, FR4 of the Timing tower redesign), shared by the advanced-stats fragment and the
 * browser script src/scripts/compareView.ts. Kept free of server imports so the page script stays small.
 */

export type CompareEntityType = 'driver' | 'team' | 'car';

/** One pickable driver, team or car with its totals for the chosen class and season. */
export interface CompareEntity {
  /** `d:<driver id>`, `h:<n>` (hidden driver n), `t:<team id>` or `c:<car name>`. */
  key: string;
  type: CompareEntityType;
  /** Shown name; a hidden driver's picker label is "Hidden Driver N". */
  name: string;
  imageUrl: string | null;
  href: string | null;
  starts: number;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  laps: number;
  lapsLed: number;
  /** Null shows a dash (cars always, teams under Alpha or Gamma). */
  championships: number | null;
  /** Drivers only; null shows a dash. */
  cornersPerIncident: number | null;
  /** Races with at least one start: a driver's starts, a team's or car's busiest driver per round, summed. */
  racesEntered: number;
  /** The laps the races it started ran: the Lap completion denominator. */
  raceLaps: number;
  /** Finished championship seasons the filters cover; null where Championships is a dash. */
  championshipSeasons: number | null;
}

/** What the fragment embeds for the browser. */
export interface CompareData {
  classLabel: string;
  seasonLabel: string;
  /** Races the Class and Season filters cover: the Starts % denominator. */
  races: number;
  drivers: CompareEntity[];
  teams: CompareEntity[];
  cars: CompareEntity[];
}

export const DASH = '—';

const KEY_PREFIX: Record<CompareEntityType, string> = { driver: 'd', team: 't', car: 'c' };
const TYPE_BY_PREFIX: Record<string, CompareEntityType> = { d: 'driver', h: 'driver', t: 'team', c: 'car' };

export function formatEntityKey(type: CompareEntityType, id: string): string {
  return `${KEY_PREFIX[type]}:${id}`;
}

/** A hidden driver's opaque key, `h:<n>` for "Hidden Driver n": never their id (BR4.3). */
export function hiddenDriverKey(n: number): string {
  return `h:${n}`;
}

/**
 * The type and id in a slot key, or null when it is not one (BR4.4). For a hidden driver's `h:<n>` the id is
 * the number n.
 */
export function parseEntityKey(
  key: string | null | undefined,
): { type: CompareEntityType; id: string } | null {
  if (!key) return null;
  const match = /^([dtch]):(.+)$/.exec(key);
  if (!match) return null;
  return { type: TYPE_BY_PREFIX[match[1]], id: match[2] };
}

/** `count` as a percentage of `denominator`; null (a dash) when the denominator is unknown or 0 (FR3.8). */
export function percentOf(count: number, denominator: number | null | undefined): number | null {
  return typeof denominator === 'number' && denominator > 0 ? (count / denominator) * 100 : null;
}

/**
 * A Percent as shown (FR3.7, FR3.8): one decimal, a dash for an unknown or zero denominator (null), and an
 * empty string for a row or entry that has no Percent at all (undefined).
 */
export function formatPercentValue(value: number | null | undefined): string {
  if (value === undefined) return '';
  if (value === null || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(1)}%`;
}

/** `count` per `denominator` as shown: `24.0%`, or a dash when the denominator is unknown or 0. */
export function formatPercent(count: number, denominator: number | null | undefined): string {
  return formatPercentValue(percentOf(count, denominator));
}

/**
 * Leaders for one row of Totals or of Percents across the slots (FR4.2, FR4.3). Only numeric values count, so
 * a dash or blank never leads; with fewer than two, or a best of 0, there is no leader. Higher is better and
 * every tied best leads.
 */
export function rowLeaders(values: (number | null | undefined)[]): { leaders: boolean[] } {
  const numeric = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const best = numeric.length > 0 ? Math.max(...numeric) : 0;
  const hasLeader = numeric.length >= 2 && best > 0;
  return { leaders: values.map((v) => hasLeader && v === best) };
}

/** Each slot's colour, by position: slots never take the class colours' meaning. */
export const SLOT_COLOURS = ['blue', 'pink', 'gold', 'grey'] as const;
export type SlotColour = (typeof SLOT_COLOURS)[number];

/**
 * The colours of a stat tab's edge: one per leading slot in slot order, split evenly on a tie, or none (a
 * neutral line) when nothing leads.
 */
export function edgeColours(leaders: boolean[]): SlotColour[] {
  return leaders.flatMap((lead, i) => (lead && SLOT_COLOURS[i] ? [SLOT_COLOURS[i]] : []));
}

/** What a Percent is measured against, for the rows that need more than the entity itself. */
export interface CompareRowContext {
  /** Races the filters cover (CompareData.races). */
  races: number;
}

export interface CompareRowDef {
  key: string;
  /** The stat's one label (FR2.1). */
  label: string;
  /** The Percent's denominator as small text under the label, for example "% of starts"; '' for none. */
  denominator: string;
  total: {
    /** The number Total leaders compare; null is a dash. */
    value: (e: CompareEntity) => number | null;
    format: (e: CompareEntity) => string;
  };
  /** The Percent: a number, null for a dash, or undefined for a blank Percent space (FR3.2, FR3.6). */
  percent: (e: CompareEntity, ctx: CompareRowContext) => number | null | undefined;
}

type CountKey = 'starts' | 'wins' | 'podiums' | 'top5s' | 'top10s' | 'poles' | 'laps' | 'lapsLed';

const countTotal = (key: CountKey) => ({
  value: (e: CompareEntity) => e[key],
  format: (e: CompareEntity) => e[key].toLocaleString('en-US'),
});

const perStart = (key: CountKey, label: string): CompareRowDef => ({
  key,
  label,
  denominator: '% of starts',
  total: countTotal(key),
  percent: (e) => percentOf(e[key], e.starts),
});

/** The ten rows in order (FR3.2, FR3.3): Win % and Podium % are now the Wins and Podiums Percents. */
export const COMPARE_ROWS: readonly CompareRowDef[] = [
  {
    key: 'starts',
    label: 'Starts',
    denominator: '% of races',
    total: countTotal('starts'),
    // Races entered, not starts, so a team with two cars in a race counts it once and stays within 100%.
    percent: (e, ctx) => percentOf(e.racesEntered, ctx.races),
  },
  perStart('wins', 'Wins'),
  perStart('podiums', 'Podiums'),
  perStart('top5s', 'Top 5s'),
  perStart('top10s', 'Top 10s'),
  perStart('poles', 'Poles'),
  {
    key: 'laps',
    label: 'Laps',
    denominator: '% of race laps',
    total: countTotal('laps'),
    percent: (e) => percentOf(e.laps, e.raceLaps),
  },
  {
    key: 'lapsLed',
    label: 'Laps Led',
    denominator: '% of laps',
    total: countTotal('lapsLed'),
    percent: (e) => percentOf(e.lapsLed, e.laps),
  },
  {
    key: 'championships',
    label: 'Championships',
    denominator: '% of finished seasons',
    total: {
      value: (e) => e.championships,
      format: (e) => (e.championships === null ? DASH : e.championships.toLocaleString('en-US')),
    },
    percent: (e) =>
      e.championships === null ? undefined : percentOf(e.championships, e.championshipSeasons),
  },
  {
    key: 'cpi',
    label: 'Corners per Incident',
    denominator: '',
    total: {
      value: (e) => e.cornersPerIncident,
      format: (e) => (e.cornersPerIncident === null ? DASH : e.cornersPerIncident.toFixed(1)),
    },
    percent: () => undefined,
  },
];

/**
 * The season number in a `season` address value, only in canonical form (1-3 digits, no leading zero);
 * anything else is null and means All. The page and the edge-cache key both read it, so `07`, `0007` or
 * `9999` can never render their own copy (BR5.2).
 */
export function canonicalSeasonNumber(value: string | null | undefined): number | null {
  return value && /^[1-9]\d{0,2}$/.test(value) ? Number(value) : null;
}

/** The address values holding the four slots. */
export const SLOT_PARAMS = ['a', 'b', 'c', 'd'] as const;

/** The four slot keys in an address's query string; a missing slot is null. */
export function readPicks(search: string): (string | null)[] {
  const params = new URLSearchParams(search);
  return SLOT_PARAMS.map((p) => params.get(p) || null);
}

/** The query string with the slots set to `picks` (an empty slot is removed), other values kept. */
export function writePicks(search: string, picks: (string | null)[]): string {
  const params = new URLSearchParams(search);
  SLOT_PARAMS.forEach((p, i) => {
    const key = picks[i];
    if (key) params.set(p, key);
    else params.delete(p);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Only the slot values of a query string, for carrying the picks to a new Class or Season address. */
export function pickParams(search: string): string {
  return writePicks('', readPicks(search)).replace(/^\?/, '');
}

export interface PickerGroup {
  type: CompareEntityType;
  label: string;
  items: CompareEntity[];
  /** How many more matched than are listed. */
  more: number;
}

export const PICKER_GROUP_LIMIT = 50;

/**
 * The picker's results for a query: case-insensitive substring of the shown name, grouped Drivers, Teams, Cars,
 * each capped at `limit` with a count of the rest. Empty groups are left out.
 */
export function filterPickerEntries(
  data: Pick<CompareData, 'drivers' | 'teams' | 'cars'>,
  query: string,
  limit = PICKER_GROUP_LIMIT,
): PickerGroup[] {
  const term = query.trim().toLowerCase();
  const groups: [CompareEntityType, string, CompareEntity[]][] = [
    ['driver', 'Drivers', data.drivers],
    ['team', 'Teams', data.teams],
    ['car', 'Cars', data.cars],
  ];
  const out: PickerGroup[] = [];
  for (const [type, label, entities] of groups) {
    const matches = term ? entities.filter((e) => e.name.toLowerCase().includes(term)) : entities;
    if (matches.length === 0) continue;
    out.push({ type, label, items: matches.slice(0, limit), more: Math.max(0, matches.length - limit) });
  }
  return out;
}

/** Each slot's entity, or null when the slot is empty or its key is not in the lists (BR4.4). */
export function resolvePicks(
  data: Pick<CompareData, 'drivers' | 'teams' | 'cars'>,
  picks: (string | null)[],
): (CompareEntity | null)[] {
  const byKey = new Map<string, CompareEntity>();
  for (const e of [...data.drivers, ...data.teams, ...data.cars]) byKey.set(e.key, e);
  return picks.map((key) => (key && parseEntityKey(key) ? (byKey.get(key) ?? null) : null));
}
