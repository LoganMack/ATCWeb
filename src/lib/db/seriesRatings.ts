/**
 * The Series iRating list (FR7): one row per driver for one rating kind, read from the masked view
 * series_ratings_shown (20261121120000_series_irating.sql). The database keeps the ratings; this only reads the
 * stored summaries, so a page view does no rating maths (NFR1) and gets at most 20 trend values per driver
 * (NFR2). Hidden drivers arrive already masked: "Hidden Driver", no driver id, an opaque key (FR7.3, NFR4).
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
  const found = RATING_KINDS.find((kind) => RATING_KIND_PARAMS[kind] !== null && RATING_KIND_PARAMS[kind] === value);
  return found ?? 'overall';
}

/**
 * Shapes the view's rows for the page: highest current rating first (then most races, then name, so the order
 * is stable), the trend capped at the last 20 values, and the driver id dropped unless the row is linkable.
 */
export function shapeSeriesRatings(rows: readonly SeriesRatingViewRow[]): SeriesRatingRow[] {
  return rows
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
 * Every driver's summary in one rating kind. Throws when the read fails, so the fragment can show its load
 * error; an empty list (no rated races in that kind yet) is not an error.
 */
export async function getSeriesRatings(env: SupabaseEnv, kind: RatingKind): Promise<SeriesRatingRow[]> {
  const { path, select } = privacyReads.seriesRatings;
  const rows = await restGetAll<SeriesRatingViewRow>(
    env,
    `${path}?select=${select}&kind=eq.${kind}&order=current.desc,driver_key.asc`,
  );
  return shapeSeriesRatings(rows);
}
