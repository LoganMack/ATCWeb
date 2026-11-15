/**
 * The driver profile Bests tab's Delta column (BR2.2, BR2.4): whether the driver's personal best equals or beats
 * the record shown, and their personal best minus that record as a signed lap time. Only times are compared,
 * never the holder's name.
 */

/** Shown in the Delta cell when the personal best equals or beats the record. */
export const HOLDS_RECORD_DELTA = '---';
/** Shown in the Delta cell when either time is missing. */
export const MISSING_DELTA = '—';

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
  /** The personal best equals or beats the record: Delta shows '---' and the PB is blue. */
  holdsRecord: boolean;
  /** The Delta cell's text: '---', '—' or a signed lap time. */
  text: string;
  /** Signed milliseconds for sorting; null when the cell sorts last (BR2.4). */
  sortValue: number | null;
}

/**
 * The Delta for one Bests row and filter (BR2.2). The personal best is in ten-thousandths of a second and the
 * record in seconds; both are compared to the millisecond.
 */
export function bestsDelta(input: {
  personalBestTenThousandths: number | null;
  trackRecordSeconds: number | null;
}): BestsDelta {
  if (input.personalBestTenThousandths === null || input.trackRecordSeconds === null) {
    return { holdsRecord: false, text: MISSING_DELTA, sortValue: null };
  }
  const deltaMs =
    Math.round(input.personalBestTenThousandths / 10) - Math.round(input.trackRecordSeconds * 1000);
  if (deltaMs <= 0) return { holdsRecord: true, text: HOLDS_RECORD_DELTA, sortValue: null };
  return { holdsRecord: false, text: formatSignedLapDelta(deltaMs), sortValue: deltaMs };
}
