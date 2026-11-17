/**
 * podiumLayout: the home Previous Result card shows its top three as tiles in podium order (2nd, 1st, 3rd)
 * and keeps 4th and 5th as rows. Hidden drivers arrive already masked; the tile must still show no photo
 * and no name letter for them.
 */
import { describe, expect, it } from 'vitest';
import { isUnrosteredId, podiumLayout } from '../../src/lib/home/podium';
import { driverInitialBadge, driverPhoto, HIDDEN_DRIVER_NAME } from '../../src/lib/privacy';

interface Row {
  position: number | null;
  name: string;
}
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ position: i + 1, name: `D${i + 1}` }));
const names = (slots: { row: Row }[]) => slots.map((s) => s.row.name);

describe('podiumLayout', () => {
  it('returns nothing for an empty session', () => {
    expect(podiumLayout([])).toEqual({ tiles: [], rest: [] });
  });

  it('shows a lone winner as the only tile', () => {
    const { tiles, rest } = podiumLayout(rows(1));
    expect(tiles).toEqual([{ place: 1, row: rows(1)[0] }]);
    expect(rest).toEqual([]);
  });

  it('puts 2nd before 1st when only two drivers finished', () => {
    expect(names(podiumLayout(rows(2)).tiles)).toEqual(['D2', 'D1']);
  });

  it('orders three tiles 2nd, 1st, 3rd', () => {
    const { tiles } = podiumLayout(rows(3));
    expect(names(tiles)).toEqual(['D2', 'D1', 'D3']);
    expect(tiles.map((t) => t.place)).toEqual([2, 1, 3]);
  });

  it('keeps 4th and 5th as rows below the podium', () => {
    const { tiles, rest } = podiumLayout(rows(5));
    expect(tiles).toHaveLength(3);
    expect(names(rest)).toEqual(['D4', 'D5']);
    expect(rest.map((r) => r.place)).toEqual([4, 5]);
  });

  it('falls back to the row order when a position is missing', () => {
    const { tiles } = podiumLayout([{ position: null, name: 'A' }, { position: null, name: 'B' }]);
    expect(tiles.map((t) => t.place)).toEqual([2, 1]);
  });

  it('passes a hidden driver in 1st through unchanged, with no photo and no letter', () => {
    const hidden = {
      position: 1,
      name: HIDDEN_DRIVER_NAME,
      driver: { name: HIDDEN_DRIVER_NAME, photo_url: 'https://x.supabase.co/a.png', car_number: null, is_hidden: true },
    };
    const { tiles } = podiumLayout([hidden, { position: 2, name: 'D2', driver: null }]);
    const winner = tiles.find((t) => t.place === 1)!;
    expect(winner.row).toBe(hidden);
    expect(winner.row.name).toBe(HIDDEN_DRIVER_NAME);
    expect(driverPhoto(winner.row.driver)).toBeNull();
    expect(driverInitialBadge(winner.row.driver)).toBe('');
  });

  it('recognises unrostered driver ids, which have no profile link', () => {
    expect(isUnrosteredId('unrostered:12345')).toBe(true);
    expect(isUnrosteredId('6f1c0a6e-0000-0000-0000-000000000000')).toBe(false);
    expect(isUnrosteredId(null)).toBe(false);
  });
});
