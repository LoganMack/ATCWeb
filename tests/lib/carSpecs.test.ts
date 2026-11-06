/**
 * The Cars page data (FR2.1-FR2.6, BR2.1-BR2.5): the four cars in their fixed order, the ten common fields,
 * metric with imperial in brackets, and the corrections to the source sheets.
 */
import { describe, expect, it } from 'vitest';
import {
  CAR_SPECS,
  carSpecRows,
  formatDisplacement,
  formatLength,
  formatWeight,
  hasCarPage,
} from '../../src/lib/carSpecs';

describe('CAR_SPECS (BR2.1, BR2.3)', () => {
  it('lists the four series cars in the fixed order, by exact iRacing name', () => {
    expect(CAR_SPECS.map((c) => c.carName)).toEqual([
      'Hyundai Veloster N TCR',
      'Hyundai Elantra N TCR',
      'Honda Civic Type R TCR',
      'Audi RS3 LMS Gen2 TCR',
    ]);
    expect(hasCarPage('[Legacy] Audi RS3 LMS TCR')).toBe(false);
    expect(hasCarPage('Audi RS3 LMS Gen2 TCR')).toBe(true);
  });

  it('gives every card the same ten filled fields', () => {
    for (const spec of CAR_SPECS) {
      const rows = carSpecRows(spec);
      expect(rows.map((r) => r.label)).toEqual([
        'Length',
        'Width',
        'Wheelbase',
        'Minimum weight (incl. driver)',
        'Engine',
        'Displacement',
        'Maximum power',
        'Front suspension',
        'Rear suspension',
        'Wheels',
      ]);
      for (const row of rows) expect(row.value.trim(), `${spec.carName} ${row.label}`).not.toBe('');
    }
  });
});

describe('formatting (BR2.4)', () => {
  it('shows millimetres with inches to one decimal, keeping a whole number’s .0', () => {
    expect(formatLength(4600)).toBe('4,600 mm (181.1 in)');
    expect(formatLength(2664)).toBe('2,664 mm (104.9 in)');
    expect(formatLength(254)).toBe('254 mm (10.0 in)');
  });

  it('shows kilograms with whole pounds and cc with comma thousands', () => {
    expect(formatWeight(1265)).toBe('1,265 kg (2,789 lb)');
    expect(formatWeight(1300)).toBe('1,300 kg (2,866 lb)');
    expect(formatDisplacement(1998)).toBe('1,998 cc');
    expect(formatDisplacement(500)).toBe('500 cc');
  });
});

describe('source sheet corrections (BR2.5)', () => {
  const card = (name: string) => {
    const spec = CAR_SPECS.find((c) => c.carName === name)!;
    return Object.fromEntries(carSpecRows(spec).map((r) => [r.label, r.value]));
  };

  it('corrects the Audi width, weight and displacement', () => {
    expect(card('Audi RS3 LMS Gen2 TCR')).toMatchObject({
      Width: '1,950 mm (76.8 in)',
      'Minimum weight (incl. driver)': '1,300 kg (2,866 lb)',
      Displacement: '2,000 cc',
      'Maximum power': '340 hp (BoP)',
    });
  });

  it('derives the Honda’s pounds from its kilograms, not the sheet’s 2,783 lb', () => {
    expect(card('Honda Civic Type R TCR')['Minimum weight (incl. driver)']).toBe('1,265 kg (2,789 lb)');
    expect(card('Honda Civic Type R TCR')['Maximum power']).toBe('340 bhp');
  });
});
