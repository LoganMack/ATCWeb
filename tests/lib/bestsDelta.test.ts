/**
 * The Bests tab's Delta (FR1.2-FR1.5; BR1.1-BR1.3): the name-matched record holder, the signed lap-time
 * difference, and the missing cases that sort last.
 */
import { describe, expect, it } from 'vitest';
import {
  HOLDS_RECORD_DELTA,
  MISSING_DELTA,
  bestsDelta,
  formatSignedLapDelta,
  holdsLayoutRecord,
} from '../../src/lib/driverPage/bestsDelta';

describe('holdsLayoutRecord (BR1.1)', () => {
  it('matches the holder text ignoring case and surrounding spaces', () => {
    expect(holdsLayoutRecord('  ana silva ', 'Ana Silva')).toBe(true);
  });

  it('does not match another driver, a blank holder or a missing name', () => {
    expect(holdsLayoutRecord('Ana Silvas', 'Ana Silva')).toBe(false);
    expect(holdsLayoutRecord('', 'Ana Silva')).toBe(false);
    expect(holdsLayoutRecord(null, 'Ana Silva')).toBe(false);
    expect(holdsLayoutRecord('Ana Silva', null)).toBe(false);
  });

  it('never matches the masked Hidden Driver stand-in', () => {
    expect(holdsLayoutRecord('Hidden Driver', 'Hidden Driver')).toBe(false);
  });

  it('ignores the trailing digits iRacing adds to duplicate names', () => {
    expect(holdsLayoutRecord('Ana Silva', 'Ana Silva2')).toBe(true);
  });
});

describe('formatSignedLapDelta', () => {
  it('signs and pads like a lap time', () => {
    expect(formatSignedLapDelta(512)).toBe('+0:00.512');
    expect(formatSignedLapDelta(-512)).toBe('-0:00.512');
    expect(formatSignedLapDelta(61_005)).toBe('+1:01.005');
    expect(formatSignedLapDelta(0)).toBe('+0:00.000');
  });
});

describe('bestsDelta (BR1.2, BR1.3)', () => {
  const base = { recordHolder: 'Someone Else', driverName: 'Ana Silva' };

  it('shows PB minus record with its signed sort value', () => {
    const delta = bestsDelta({ ...base, personalBestTenThousandths: 1_025_120, trackRecordSeconds: 102.0 });
    expect(delta).toEqual({ holdsRecord: false, text: '+0:00.512', sortValue: 512 });
  });

  it('goes negative when the personal best beats the curated record', () => {
    const delta = bestsDelta({ ...base, personalBestTenThousandths: 1_014_880, trackRecordSeconds: 102.0 });
    expect(delta.text).toBe('-0:00.512');
    expect(delta.sortValue).toBe(-512);
  });

  it('shows --- with no sort value when the driver holds the record', () => {
    const delta = bestsDelta({
      personalBestTenThousandths: 1_020_000,
      trackRecordSeconds: 102.0,
      recordHolder: 'ana silva',
      driverName: 'Ana Silva',
    });
    expect(delta).toEqual({ holdsRecord: true, text: HOLDS_RECORD_DELTA, sortValue: null });
  });

  it('shows — when either time is missing', () => {
    expect(bestsDelta({ ...base, personalBestTenThousandths: null, trackRecordSeconds: 102 }).text).toBe(
      MISSING_DELTA,
    );
    const noRecord = bestsDelta({ ...base, personalBestTenThousandths: 1_020_000, trackRecordSeconds: null });
    expect(noRecord).toEqual({ holdsRecord: false, text: MISSING_DELTA, sortValue: null });
  });

  it('shows +0:00.000 for equal times by someone else', () => {
    expect(bestsDelta({ ...base, personalBestTenThousandths: 1_020_000, trackRecordSeconds: 102 }).text).toBe(
      '+0:00.000',
    );
  });
});
