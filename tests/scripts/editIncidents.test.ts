/**
 * Edit Results' browser checks (results-edit, US9.1): which values are valid, which driver is named first,
 * and which rows count as changed (only those are posted).
 */
import { describe, expect, it } from 'vitest';
import {
  changedIncidentEntries,
  findInvalidIncidents,
  isValidIncidentValue,
} from '../../src/scripts/editIncidents';

const entry = (value: string, current: string, driverName = 'Driver') => ({ value, current, driverName });

describe('isValidIncidentValue', () => {
  it('accepts whole numbers from 0 to 999', () => {
    for (const value of ['0', '7', ' 12 ', '999', '007'])
      expect(isValidIncidentValue(value), value).toBe(true);
  });

  it('refuses blanks, decimals, negatives, exponents and values over 999', () => {
    for (const value of ['', '  ', '4.5', '5.0', '-1', '1e2', '1000', 'abc'])
      expect(isValidIncidentValue(value), value).toBe(false);
  });
});

describe('findInvalidIncidents', () => {
  it('is null when every value is valid', () => {
    expect(findInvalidIncidents([entry('1', '0', 'A'), entry('0', '2', 'B')])).toBeNull();
  });

  it('names the first invalid driver when several are invalid', () => {
    expect(findInvalidIncidents([entry('1', '0', 'A'), entry('', '2', 'B'), entry('-3', '2', 'C')])).toBe(
      'B',
    );
    expect(findInvalidIncidents([entry('1000', '0', 'Over')])).toBe('Over');
  });
});

describe('changedIncidentEntries', () => {
  it('keeps only rows whose count differs from the page, treating "05" as 5', () => {
    const rows = [entry('4', '4', 'Same'), entry('05', '5', 'Padded'), entry('6', '5', 'Changed')];
    expect(changedIncidentEntries(rows).map((row) => row.driverName)).toEqual(['Changed']);
  });

  it('counts an invalid value as changed so it is checked, and a filled-in missing count too', () => {
    expect(changedIncidentEntries([entry('', '3', 'Blanked')])).toHaveLength(1);
    expect(changedIncidentEntries([entry('2', '', 'Was missing')])).toHaveLength(1);
    expect(changedIncidentEntries([entry('', '', 'Still missing')])).toHaveLength(0);
  });
});
