/**
 * The Bests tab's Delta (BR2.2, BR2.4): blue and "---" when the personal best equals or beats the record by
 * time, the signed lap-time difference otherwise, and the missing cases that sort last.
 */
import { describe, expect, it } from 'vitest';
import {
  HOLDS_RECORD_DELTA,
  MISSING_DELTA,
  bestsDelta,
  formatSignedLapDelta,
} from '../../src/lib/driverPage/bestsDelta';

describe('formatSignedLapDelta', () => {
  it('signs and pads like a lap time', () => {
    expect(formatSignedLapDelta(512)).toBe('+0:00.512');
    expect(formatSignedLapDelta(-512)).toBe('-0:00.512');
    expect(formatSignedLapDelta(61_005)).toBe('+1:01.005');
    expect(formatSignedLapDelta(0)).toBe('+0:00.000');
  });
});

describe('bestsDelta (BR2.2, BR2.4)', () => {
  it('shows PB minus record with its signed sort value', () => {
    const delta = bestsDelta({ personalBestTenThousandths: 1_025_120, trackRecordSeconds: 102.0 });
    expect(delta).toEqual({ holdsRecord: false, text: '+0:00.512', sortValue: 512 });
  });

  it('shows --- with no sort value when the personal best equals the record to the millisecond', () => {
    expect(bestsDelta({ personalBestTenThousandths: 1_020_004, trackRecordSeconds: 102 })).toEqual({
      holdsRecord: true,
      text: HOLDS_RECORD_DELTA,
      sortValue: null,
    });
  });

  it('shows --- when the personal best beats the shown record', () => {
    const delta = bestsDelta({ personalBestTenThousandths: 1_014_880, trackRecordSeconds: 102.0 });
    expect(delta).toEqual({ holdsRecord: true, text: HOLDS_RECORD_DELTA, sortValue: null });
  });

  it('shows — when either time is missing', () => {
    expect(bestsDelta({ personalBestTenThousandths: null, trackRecordSeconds: 102 }).text).toBe(
      MISSING_DELTA,
    );
    const noRecord = bestsDelta({ personalBestTenThousandths: 1_020_000, trackRecordSeconds: null });
    expect(noRecord).toEqual({ holdsRecord: false, text: MISSING_DELTA, sortValue: null });
  });

  it('is not blue when one millisecond slower', () => {
    const delta = bestsDelta({ personalBestTenThousandths: 1_020_010, trackRecordSeconds: 102 });
    expect(delta).toEqual({ holdsRecord: false, text: '+0:00.001', sortValue: 1 });
  });
});
