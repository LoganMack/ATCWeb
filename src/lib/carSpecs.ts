/**
 * The four series cars' specification cards for /cars (FR2, BR2.1-BR2.5). Fixed data in code: four records
 * with no admin editing. Only fields present in all four spec sheets are kept (BR2.3), and the known errors in
 * the sheets are corrected here (BR2.5): the Audi's width (195 mm in its sheet) is 1,950 mm, its weight is
 * 1,300 kg (labelled lbs in its sheet), its "2.0 L" engine is 2,000 cc, and the Honda's pounds come from its
 * 1,265 kg, not the sheet's 2,783 lb.
 */

export interface CarSpec {
  /** Exact iRacing name; matches car_logos.car_name and the race data. */
  carName: string;
  displayName: string;
  lengthMm: number;
  widthMm: number;
  wheelbaseMm: number;
  /** Minimum weight including the driver. */
  weightKg: number;
  engine: string;
  displacementCc: number;
  /** As given in the sheet (hp or bhp). */
  power: string;
  frontSuspension: string;
  rearSuspension: string;
  wheels: string;
}

const HYUNDAI_ENGINE = 'Turbocharged 4-cylinder in line, transversally installed';
const HYUNDAI_POWER = '350 hp @ 7,000 rpm';
const HYUNDAI_FRONT = 'McPherson strut, coil springs, gas-filled dampers, anti-roll bar';
const HYUNDAI_REAR = '4-arm multi-link axle, coil springs, gas-filled dampers, anti-roll bar';
const HYUNDAI_WHEELS = 'Braid 10" x 18" aerodynamic rims, specifically designed for Hyundai Motorsport';

/** In the fixed card order (BR2.1, FR2.6). */
export const CAR_SPECS: readonly CarSpec[] = [
  {
    carName: 'Hyundai Veloster N TCR',
    displayName: 'Hyundai Veloster N TCR',
    lengthMm: 4600,
    widthMm: 1950,
    wheelbaseMm: 2650,
    weightKg: 1265,
    engine: HYUNDAI_ENGINE,
    displacementCc: 1998,
    power: HYUNDAI_POWER,
    frontSuspension: HYUNDAI_FRONT,
    rearSuspension: HYUNDAI_REAR,
    wheels: HYUNDAI_WHEELS,
  },
  {
    carName: 'Hyundai Elantra N TCR',
    displayName: 'Hyundai Elantra N TCR',
    lengthMm: 4710,
    widthMm: 1950,
    wheelbaseMm: 2750,
    weightKg: 1265,
    engine: HYUNDAI_ENGINE,
    displacementCc: 1998,
    power: HYUNDAI_POWER,
    frontSuspension: HYUNDAI_FRONT,
    rearSuspension: HYUNDAI_REAR,
    wheels: HYUNDAI_WHEELS,
  },
  {
    carName: 'Honda Civic Type R TCR',
    displayName: 'Honda Civic Type R TCR',
    lengthMm: 4550,
    widthMm: 1950,
    wheelbaseMm: 2700,
    weightKg: 1265,
    engine: 'Turbocharged four-cylinder in line',
    displacementCc: 2000,
    power: '340 bhp',
    frontSuspension: 'McPherson strut, coil springs, gas-filled dampers, anti-roll bar',
    rearSuspension: 'Multi-link axle, coil springs, gas-filled dampers, anti-roll bar',
    wheels: '18"',
  },
  {
    carName: 'Audi RS3 LMS Gen2 TCR',
    displayName: 'Audi RS3 LMS Gen2 TCR',
    lengthMm: 4575,
    widthMm: 1950,
    wheelbaseMm: 2664,
    weightKg: 1300,
    engine: '4-cylinder 2.0 L turbocharged',
    displacementCc: 2000,
    power: '340 hp (BoP)',
    frontSuspension: 'Strut',
    rearSuspension: 'Multi-link',
    wheels: '10" wide x 18" diameter aluminium alloy',
  },
];

const MM_PER_INCH = 25.4;
const LB_PER_KG = 2.20462;

/** Thousands separated with a comma, independent of the server's locale. */
function withCommas(n: number | string): string {
  const [whole, fraction] = String(n).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** "4,600 mm (181.1 in)": inches = mm / 25.4 to one decimal (BR2.4). */
export function formatLength(mm: number): string {
  // A string, so a whole number of inches keeps its ".0".
  const inches = (Math.round((mm / MM_PER_INCH) * 10) / 10).toFixed(1);
  return `${withCommas(mm)} mm (${withCommas(inches)} in)`;
}

/** "1,265 kg (2,789 lb)": pounds = kg x 2.20462, whole (BR2.4). */
export function formatWeight(kg: number): string {
  return `${withCommas(kg)} kg (${withCommas(Math.round(kg * LB_PER_KG))} lb)`;
}

/** "1,998 cc" (BR2.4). */
export function formatDisplacement(cc: number): string {
  return `${withCommas(cc)} cc`;
}

/** One card's ten rows, labelled and formatted, in display order (BR2.3). */
export function carSpecRows(spec: CarSpec): { label: string; value: string }[] {
  return [
    { label: 'Length', value: formatLength(spec.lengthMm) },
    { label: 'Width', value: formatLength(spec.widthMm) },
    { label: 'Wheelbase', value: formatLength(spec.wheelbaseMm) },
    { label: 'Minimum weight (incl. driver)', value: formatWeight(spec.weightKg) },
    { label: 'Engine', value: spec.engine },
    { label: 'Displacement', value: formatDisplacement(spec.displacementCc) },
    { label: 'Maximum power', value: spec.power },
    { label: 'Front suspension', value: spec.frontSuspension },
    { label: 'Rear suspension', value: spec.rearSuspension },
    { label: 'Wheels', value: spec.wheels },
  ];
}

/** Whether a car has a card on /cars, so Compare can link it there. */
export function hasCarPage(carName: string): boolean {
  return CAR_SPECS.some((c) => c.carName === carName);
}
