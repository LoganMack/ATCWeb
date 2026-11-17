/**
 * Splits the Previous Result card's top-five driver rows into the podium tiles (shown 2nd, 1st, 3rd, as on
 * a real podium) and the rows below them (4th and 5th). Rows arrive already ordered and already masked for
 * hidden drivers, so this only reorders them.
 */
export interface PodiumSlot<Row> {
  place: number;
  row: Row;
}

export interface PodiumLayout<Row> {
  tiles: PodiumSlot<Row>[];
  rest: PodiumSlot<Row>[];
}

const TILE_ORDER = [1, 0, 2];

export function podiumLayout<Row extends { position: number | null }>(rows: readonly Row[]): PodiumLayout<Row> {
  const slot = (i: number): PodiumSlot<Row> | null => {
    const row = rows[i];
    return row ? { place: row.position ?? i + 1, row } : null;
  };
  const tiles = TILE_ORDER.map(slot).filter((s): s is PodiumSlot<Row> => s !== null);
  const rest = [3, 4].map(slot).filter((s): s is PodiumSlot<Row> => s !== null);
  return { tiles, rest };
}

/** Unrostered drivers (ids like `unrostered:123`) have no profile page to link to. */
export function isUnrosteredId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('unrostered:');
}
