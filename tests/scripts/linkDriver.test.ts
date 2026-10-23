/**
 * The linking page's search (U2 driver-linking, BR3.4): by name (case-insensitive, trimmed), by leading digits
 * of the car number, and the empty states. Pure functions only; the DOM wiring is not loaded in Node.
 */
import { describe, expect, it } from 'vitest';
import { filterDrivers, matchesDriver, type FilterableDriver } from '../../src/scripts/linkDriver';

const roster: FilterableDriver[] = [
  { name: 'Amy Brown', number: '12' },
  { name: 'Bea Browning', number: '7' },
  { name: 'Carl 123', number: '' },
  { name: 'Dan Driver', number: '120' },
];
const names = (list: FilterableDriver[]) => list.map((d) => d.name);

describe('filterDrivers', () => {
  it('matches part of a name, ignoring case and surrounding spaces', () => {
    expect(names(filterDrivers(roster, '  BROW '))).toEqual(['Amy Brown', 'Bea Browning']);
  });

  it('matches car numbers by their leading digits', () => {
    expect(names(filterDrivers(roster, '12'))).toEqual(['Amy Brown', 'Carl 123', 'Dan Driver']);
    expect(names(filterDrivers(roster, '7'))).toEqual(['Bea Browning']);
    // "2" is inside 12 and 120 but starts neither, and is in no name.
    expect(names(filterDrivers(roster, '2'))).toEqual(['Carl 123']);
  });

  it('returns every driver for an empty query and none when nothing matches', () => {
    expect(filterDrivers(roster, '   ')).toHaveLength(roster.length);
    expect(filterDrivers(roster, 'xyz')).toEqual([]);
    expect(filterDrivers([], 'amy')).toEqual([]);
  });

  it('never matches a number for a driver without one', () => {
    expect(matchesDriver({ name: 'No Number', number: '' }, '1')).toBe(false);
  });
});
