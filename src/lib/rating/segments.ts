/**
 * The up and down rule for Series iRating lines: each segment between two ratings is 'up' (blue) when the
 * rating rises and 'down' (red) when it falls, compared on whole numbers, since whole numbers are what the
 * page shows. A flat segment keeps the previous direction, and a flat first segment is 'up'. Pure, so the
 * server's trend lines and the browser's chart share it.
 */

export type SegmentDirection = 'up' | 'down';

/** One direction per segment (length values.length - 1), on whole numbers; flat keeps the previous, 'up' first. */
export function segmentDirections(values: readonly number[]): SegmentDirection[] {
  const dirs: SegmentDirection[] = [];
  let previous: SegmentDirection = 'up';
  for (let k = 1; k < values.length; k++) {
    const a = Math.round(values[k - 1]);
    const b = Math.round(values[k]);
    const dir: SegmentDirection = b > a ? 'up' : b < a ? 'down' : previous;
    dirs.push(dir);
    previous = dir;
  }
  return dirs;
}

/** Merges consecutive equal directions: [{ direction, from, to }] as point indexes; adjacent runs share a point. */
export function directionRuns(
  dirs: readonly SegmentDirection[],
): { direction: SegmentDirection; from: number; to: number }[] {
  const runs: { direction: SegmentDirection; from: number; to: number }[] = [];
  for (let k = 0; k < dirs.length; k++) {
    const last = runs[runs.length - 1];
    if (last && last.direction === dirs[k]) last.to = k + 1;
    else runs.push({ direction: dirs[k], from: k, to: k + 1 });
  }
  return runs;
}
