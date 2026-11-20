/**
 * The Series iRating list and history (FR7): one row per driver for one rating kind, read from the masked view
 * series_ratings_shown, and one driver's every rated race from series_rating_history_shown
 * (20261121120000_series_irating.sql). The database keeps the ratings; this only reads stored values, so a page
 * view does no rating maths (NFR1), the list gets at most 20 trend values per driver (NFR2) and a driver's full
 * history is read only when their row is opened. Hidden drivers arrive already masked: "Hidden Driver", no
 * driver id, an opaque key (FR7.3, NFR4).
 */
import { restGetAll, type SupabaseEnv } from './client';
import privacyReads from '../privacyReads.json';

export const RATING_KINDS = ['overall', 'alpha', 'gamma', 'delta'] as const;
export type RatingKind = (typeof RATING_KINDS)[number];

/** The Class filter's labels, in the order the select lists them. */
export const RATING_KIND_LABELS: Record<RatingKind, string> = {
  overall: 'Overall',
  alpha: 'Alpha',
  gamma: 'Gamma',
  delta: 'Delta',
};

/** A driver needs this many rated races in a kind before the list shows them; fewer are never sent. */
export const MIN_RATED_RACES = 5;

/** One row as the view returns it. */
export interface SeriesRatingViewRow {
  kind: string;
  driver_key: string;
  name: string | null;
  linkable: boolean | null;
  driver_id: string | null;
  current: number;
  last_change: number;
  minimum: number;
  maximum: number;
  races: number;
  trend: number[] | null;
}

/** One driver in the list (RatingLeaderboardRow). */
export interface SeriesRatingRow {
  key: string;
  name: string;
  /** Null for a hidden driver, so no link and no real id reach the page (FR7.4). */
  driverId: string | null;
  current: number;
  lastChange: number;
  minimum: number;
  maximum: number;
  races: number;
  /** Up to 20 ratings, oldest first (NFR2). */
  trend: number[];
}

/**
 * The `class` address value of each kind: the same values the Compare class filter uses, so the edge cache's
 * class rule (CLASS_FILTER_VALUES) keeps them and drops anything else to the bare key that renders Overall.
 */
export const RATING_KIND_PARAMS: Record<RatingKind, string | null> = {
  overall: null,
  alpha: 'Alpha',
  gamma: 'Gamma',
  delta: 'Delta',
};

/** The kind a `class` address value asks for; matching is exact, and anything else is Overall (BR3.13). */
export function resolveRatingKind(value: string | null | undefined): RatingKind {
  const found = RATING_KINDS.find(
    (kind) => RATING_KIND_PARAMS[kind] !== null && RATING_KIND_PARAMS[kind] === value,
  );
  return found ?? 'overall';
}

/**
 * Shapes the view's rows for the page: drivers with fewer than MIN_RATED_RACES races left out (the read
 * already filters them; this keeps the rule in one place for any other caller), highest current rating first
 * (then most races, then name, so the order is stable), the trend capped at the last 20 values, and the driver
 * id dropped unless the row is linkable.
 */
export function shapeSeriesRatings(rows: readonly SeriesRatingViewRow[]): SeriesRatingRow[] {
  return rows
    .filter((row) => row.races >= MIN_RATED_RACES)
    .map((row) => {
      const linkable = row.linkable === true && row.driver_id !== null;
      const trend = Array.isArray(row.trend) ? row.trend.slice(-20) : [];
      return {
        key: row.driver_key,
        name: row.name ?? 'Hidden Driver',
        driverId: linkable ? row.driver_id : null,
        current: row.current,
        lastChange: row.last_change,
        minimum: row.minimum,
        maximum: row.maximum,
        races: row.races,
        trend,
      };
    })
    .sort((a, b) => b.current - a.current || b.races - a.races || a.name.localeCompare(b.name));
}

/**
 * Every driver's summary in one rating kind, drivers with fewer than MIN_RATED_RACES races filtered out by the
 * database so their rows are never sent. Throws when the read fails, so the fragment can show its load error;
 * an empty list (no rated races in that kind yet) is not an error.
 */
export async function getSeriesRatings(env: SupabaseEnv, kind: RatingKind): Promise<SeriesRatingRow[]> {
  const { path, select } = privacyReads.seriesRatings;
  const rows = await restGetAll<SeriesRatingViewRow>(
    env,
    `${path}?select=${select}&kind=eq.${kind}&races=gte.${MIN_RATED_RACES}&order=current.desc,driver_key.asc`,
  );
  return shapeSeriesRatings(rows);
}

// --- One driver's history ----------------------------------------------------------------------------------

/** A list row's key: a driver id, or a hidden driver's stand-in ("h" and digits). Anything else is refused. */
const DRIVER_KEY = /^(?:h\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isRatingDriverKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && DRIVER_KEY.test(value);
}

/** One row of series_rating_history_shown. */
export interface RatingHistoryViewRow {
  kind: string;
  driver_key: string;
  race_started_at: string;
  subsession_id: number;
  race_number: number;
  round_races: number | null;
  season_number: number | null;
  season_name: string | null;
  track_name: string | null;
  position: number;
  field_size: number;
  rating_after: number;
}

/**
 * One rated race as the chart draws it, in short keys to keep the JSON small: d the round's date (YYYY-MM-DD),
 * s the season name, t the track, r the race number (0 when the round had one race), p the position used
 * (overall for Overall, class position for a class), f the field size and v the rating after the race.
 */
export interface RatingHistoryPoint {
  d: string;
  s: string;
  t: string;
  r: number;
  p: number;
  f: number;
  v: number;
}

export function shapeRatingHistory(rows: readonly RatingHistoryViewRow[]): RatingHistoryPoint[] {
  return rows.map((row) => ({
    d: row.race_started_at.slice(0, 10),
    s: row.season_name ?? (row.season_number !== null ? `Season ${row.season_number}` : ''),
    t: row.track_name ?? '',
    r: (row.round_races ?? 1) > 1 ? row.race_number : 0,
    p: row.position,
    f: row.field_size,
    v: row.rating_after,
  }));
}

/**
 * Every rated race of one driver in one kind, oldest first. The key is matched as the view masks it for the
 * caller, so a hidden driver is only ever found by their stand-in key. Throws when the read fails.
 */
export async function getSeriesRatingHistory(
  env: SupabaseEnv,
  kind: RatingKind,
  driverKey: string,
): Promise<RatingHistoryPoint[]> {
  const { path, select } = privacyReads.seriesRatingHistory;
  const rows = await restGetAll<RatingHistoryViewRow>(
    env,
    `${path}?select=${select}&kind=eq.${kind}&driver_key=eq.${encodeURIComponent(driverKey)}` +
      '&order=race_started_at.asc,subsession_id.asc,race_number.asc',
  );
  return shapeRatingHistory(rows);
}
