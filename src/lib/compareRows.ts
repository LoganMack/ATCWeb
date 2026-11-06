/**
 * The Compare view's pure helpers (BR4.4, BR4.9-BR4.11), shared by the advanced-stats fragment and the
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
}

/** What the fragment embeds for the browser. */
export interface CompareData {
  classLabel: string;
  seasonLabel: string;
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

/** Wins or podiums per start as a percentage with one decimal; a dash with no starts (BR4.9). */
export function formatRate(count: number, starts: number): string {
  if (starts <= 0) return DASH;
  return `${((count / starts) * 100).toFixed(1)}%`;
}

function rateValue(count: number, starts: number): number | null {
  return starts > 0 ? (count / starts) * 100 : null;
}

export interface RowLeaders {
  /** Per slot: whether it leads the row. */
  leaders: boolean[];
  /** Per slot: bar width as a percentage of the row's best (0 for an empty or dash cell). */
  widths: number[];
}

/**
 * Leaders and bar widths for one row across the slots (BR4.10). Only numeric values count; with fewer than
 * two, or a best of 0, there is no leader. Higher is better for every row, and every tied best leads.
 */
export function rowLeaders(values: (number | null | undefined)[]): RowLeaders {
  const numeric = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const best = numeric.length > 0 ? Math.max(...numeric) : 0;
  const hasLeader = numeric.length >= 2 && best > 0;
  return {
    leaders: values.map((v) => hasLeader && v === best),
    widths: values.map((v) => (typeof v === 'number' && best > 0 ? (Math.max(v, 0) / best) * 100 : 0)),
  };
}

export interface CompareRowDef {
  key: string;
  label: string;
  /** The number leaders and bars compare; null is a dash. */
  value: (e: CompareEntity) => number | null;
  /** The text shown. */
  format: (e: CompareEntity) => string;
}

const count = (key: 'starts' | 'wins' | 'podiums' | 'top5s' | 'top10s' | 'poles' | 'laps' | 'lapsLed') => ({
  value: (e: CompareEntity) => e[key],
  format: (e: CompareEntity) => e[key].toLocaleString('en-US'),
});

/** The twelve rows in order (FR4.5). */
export const COMPARE_ROWS: readonly CompareRowDef[] = [
  { key: 'starts', label: 'Starts', ...count('starts') },
  { key: 'wins', label: 'Wins', ...count('wins') },
  { key: 'podiums', label: 'Podiums', ...count('podiums') },
  { key: 'top5s', label: 'Top 5s', ...count('top5s') },
  { key: 'top10s', label: 'Top 10s', ...count('top10s') },
  { key: 'poles', label: 'Poles', ...count('poles') },
  { key: 'laps', label: 'Laps', ...count('laps') },
  { key: 'lapsLed', label: 'Laps Led', ...count('lapsLed') },
  {
    key: 'winRate',
    label: 'Win %',
    value: (e) => rateValue(e.wins, e.starts),
    format: (e) => formatRate(e.wins, e.starts),
  },
  {
    key: 'podiumRate',
    label: 'Podium %',
    value: (e) => rateValue(e.podiums, e.starts),
    format: (e) => formatRate(e.podiums, e.starts),
  },
  {
    key: 'championships',
    label: 'Championships',
    value: (e) => e.championships,
    format: (e) => (e.championships === null ? DASH : String(e.championships)),
  },
  {
    key: 'cpi',
    label: 'Corners per Incident',
    value: (e) => e.cornersPerIncident,
    format: (e) => (e.cornersPerIncident === null ? DASH : e.cornersPerIncident.toFixed(1)),
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
