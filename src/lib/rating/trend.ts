/**
 * The Series iRating trend line (FR7.2): an 80×20 line over a driver's last 20 ratings, its direction and its
 * screen-reader label. Each segment is coloured by its own direction (the shared rule in ./segments, drawn as
 * one polyline per run), while the direction and label describe the whole window, first value to last. Pure,
 * so the ratings fragment renders it on the server and the tests check it without a DOM.
 */
import { directionRuns, segmentDirections, type SegmentDirection } from './segments';

export const TREND_WIDTH = 80;
export const TREND_HEIGHT = 20;
/** Keeps the stroke inside the box. */
const PAD = 1.5;

export type TrendDirection = 'up' | 'down' | 'flat';

export interface TrendLine {
  /** SVG polyline points, or '' when there is nothing to draw. Kept for one release; the fragment draws runs. */
  points: string;
  direction: TrendDirection;
  label: string;
  /** One polyline per direction run; [] for 0 or 1 value. */
  runs: { direction: SegmentDirection; points: string }[];
  /** The single value's position, else null. */
  dot: { x: number; y: number } | null;
}

export function trendLine(values: readonly number[]): TrendLine {
  const shown = values.slice(-20);
  if (shown.length === 0)
    return { points: '', direction: 'flat', label: 'No rated races yet', runs: [], dot: null };
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
  const y = (v: number) =>
    span === 0 ? TREND_HEIGHT / 2 : PAD + ((max - v) / span) * (TREND_HEIGHT - 2 * PAD);
  const coords =
    shown.length === 1
      ? [
          [PAD, y(first)],
          [TREND_WIDTH - PAD, y(first)],
        ]
      : shown.map((v, i) => [PAD + i * stepX, y(v)]);
  const toPoints = (list: number[][]) => list.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
  const points = toPoints(coords);

  if (shown.length === 1) {
    return { points, direction, label, runs: [], dot: { x: TREND_WIDTH / 2, y: TREND_HEIGHT / 2 } };
  }
  const runs = directionRuns(segmentDirections(shown)).map((run) => ({
    direction: run.direction,
    points: toPoints(coords.slice(run.from, run.to + 1)),
  }));
  return { points, direction, label, runs, dot: null };
}
