/**
 * The driver profile Bests tab's Delta column (FR1; BR1.1-BR1.3): whether the driver holds the layout's curated
 * Track Record, and their personal best minus that record as a signed lap time.
 */
import { displayDriverName } from '../db/circuits';
import { HIDDEN_DRIVER_NAME } from '../privacy';

/** Shown in the Delta cell when the driver holds the record. */
export const HOLDS_RECORD_DELTA = '---';
/** Shown in the Delta cell when either time is missing. */
export const MISSING_DELTA = '—';

function normalizedName(name: string | null | undefined): string {
  return displayDriverName(name ?? '')
    .trim()
    .toLowerCase();
}

/**
 * True when the record holder text names this driver: equal ignoring case and surrounding spaces (BR1.1). The
 * masked "Hidden Driver" stand-in never matches, so a hidden driver's record is never claimed by name.
 */
export function holdsLayoutRecord(
  recordHolder: string | null | undefined,
  driverName: string | null | undefined,
): boolean {
  const holder = normalizedName(recordHolder);
  const driver = normalizedName(driverName);
  if (holder === '' || driver === '') return false;
  if (holder === HIDDEN_DRIVER_NAME.toLowerCase()) return false;
  return holder === driver;
}

/** A signed lap-time difference in milliseconds as "+M:SS.mmm" or "-M:SS.mmm" ("+0:00.000" when equal). */
export function formatSignedLapDelta(deltaMs: number): string {
  const sign = deltaMs < 0 ? '-' : '+';
  const total = Math.abs(Math.round(deltaMs));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export interface BestsDelta {
  holdsRecord: boolean;
  /** The Delta cell's text: '---', '—' or a signed lap time. */
  text: string;
  /** Signed milliseconds for sorting; null when the cell sorts as missing (BR1.3). */
  sortValue: number | null;
}

/**
 * The Delta for one Bests row (BR1.2). Times are the personal best in ten-thousandths of a second and the
 * record in seconds, as the row already holds them; both are compared to the millisecond.
 */
export function bestsDelta(input: {
  personalBestTenThousandths: number | null;
  trackRecordSeconds: number | null;
  recordHolder: string | null | undefined;
  driverName: string | null | undefined;
}): BestsDelta {
  if (holdsLayoutRecord(input.recordHolder, input.driverName)) {
    return { holdsRecord: true, text: HOLDS_RECORD_DELTA, sortValue: null };
  }
  if (input.personalBestTenThousandths === null || input.trackRecordSeconds === null) {
    return { holdsRecord: false, text: MISSING_DELTA, sortValue: null };
  }
  const deltaMs =
    Math.round(input.personalBestTenThousandths / 10) - Math.round(input.trackRecordSeconds * 1000);
  return { holdsRecord: false, text: formatSignedLapDelta(deltaMs), sortValue: deltaMs };
}
