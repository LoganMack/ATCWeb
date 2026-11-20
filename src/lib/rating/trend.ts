/**
 * The Series iRating trend line (FR7.2): an 80×20 polyline over a driver's last 20 ratings, its direction
 * (blue when the shown run ends higher than it starts, pink when lower) and its screen-reader label. Pure, so
 * the ratings fragment renders it on the server and the tests check it without a DOM.
 */

export const TREND_WIDTH = 80;
export const TREND_HEIGHT = 20;
/** Keeps the stroke inside the box. */
const PAD = 1.5;

export type TrendDirection = 'up' | 'down' | 'flat';

export interface TrendLine {
  /** SVG polyline points, or '' when there is nothing to draw. */
  points: string;
  direction: TrendDirection;
  label: string;
}

export function trendLine(values: readonly number[]): TrendLine {
  const shown = values.slice(-20);
  if (shown.length === 0) return { points: '', direction: 'flat', label: 'No rated races yet' };
  const first = shown[0];
  const last = shown[shown.length - 1];
  const direction: TrendDirection = last > first ? 'up' : last < first ? 'down' : 'flat';
  const word = direction === 'up' ? 'Rising' : direction === 'down' ? 'Falling' : 'Level';
  const races = shown.length === 1 ? '1 race' : `last ${shown.length} races`;
  const label = `${word} over ${races}, ${Math.round(first)} to ${Math.round(last)}`;

  const min = Math.min(...shown);
  const max = Math.max(...shown);
  const span = max - min;
  const stepX = shown.length > 1 ? (TREND_WIDTH - 2 * PAD) / (shown.length - 1) : 0;
  const y = (v: number) => (span === 0 ? TREND_HEIGHT / 2 : PAD + ((max - v) / span) * (TREND_HEIGHT - 2 * PAD));
  const coords = shown.length === 1 ? [[PAD, y(first)], [TREND_WIDTH - PAD, y(first)]] : shown.map((v, i) => [PAD + i * stepX, y(v)]);
  const points = coords.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
  return { points, direction, label };
}

/** Fewer than this many races marks a rating provisional (the "P" tag, FR7.2). */
export const PROVISIONAL_RACES = 5;
