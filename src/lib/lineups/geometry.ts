/**
 * The Lineup Changes board's geometry, shared by the server render (board.ts) and the team filter's relayout
 * (src/scripts/lineupBoard.ts). Imports nothing, so the client script can use it without pulling the
 * server-side board code into the browser.
 */

/** A seat row is 5 units tall (h-5) and the gap between groups 1 unit (gap-1): 1 unit is 4px at any zoom. */
export const ROW_UNITS = 5;
export const GAP_UNITS = 1;

export interface RowGroup {
  /** "New to ATC" and "Left ATC" open with a heading row of the same height as a seat. */
  heading: boolean;
  /** The group's visible seat rows; a group with none takes no space and no gap. */
  rows: number;
}

export interface Placement {
  /** Each group's row centres, in row units, in the order given; empty for a skipped group. */
  centres: number[][];
  /** The column height, in row units. */
  height: number;
}

export function placeRows(groups: readonly RowGroup[]): Placement {
  let y = 0;
  let placed = 0;
  const centres = groups.map((group) => {
    if (group.rows <= 0) return [];
    if (placed++ > 0) y += GAP_UNITS;
    if (group.heading) y += ROW_UNITS;
    const rows: number[] = [];
    for (let i = 0; i < group.rows; i++) {
      rows.push(y + ROW_UNITS / 2);
      y += ROW_UNITS;
    }
    return rows;
  });
  return { centres, height: y };
}

/** An SVG path from the left edge at y1 to the right edge at y2, in the board's 100-wide viewBox. */
export function linePath(line: { y1: number; y2: number }): string {
  const y1 = line.y1.toFixed(1);
  const y2 = line.y2.toFixed(1);
  return `M0 ${y1} C50 ${y1} 50 ${y2} 100 ${y2}`;
}
