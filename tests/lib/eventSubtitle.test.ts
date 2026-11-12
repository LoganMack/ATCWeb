/**
 * The homepage event line (FR11.2-FR11.4; BR11.1): round and final-round wording, category labels, and the
 * fallback when the round numbers could not be read.
 */
import { describe, expect, it } from 'vitest';
import { eventSubtitle, finalRoundNumbers, type SubtitleEvent } from '../../src/lib/eventSubtitle';

const SEASON = 'season-19';

function event(extra: Partial<SubtitleEvent> = {}): SubtitleEvent {
  return {
    event_date: '2026-03-04',
    category: 'championship',
    season_id: SEASON,
    round_number: 3,
    seasons: { name: 'ATC19' },
    ...extra,
  };
}

// Round 8 is a TBD event: it still counts for the final round.
const finals = finalRoundNumbers([
  { season_id: SEASON, round_number: 3 },
  { season_id: SEASON, round_number: 8 },
  { season_id: 'season-18', round_number: 10 },
]);

describe('finalRoundNumbers', () => {
  it("keeps each season's highest round number", () => {
    expect(finals.get(SEASON)).toBe(8);
    expect(finals.get('season-18')).toBe(10);
  });
});

describe('eventSubtitle (BR11.1)', () => {
  it('reads "<date> - ATCn, Round n" for a championship round', () => {
    expect(eventSubtitle(event(), finals)).toBe('March 4, 2026 - ATC19, Round 3');
  });

  it('reads "Final Round" for the highest round on record, TBD rounds included', () => {
    expect(eventSubtitle(event({ round_number: 8 }), finals)).toBe('March 4, 2026 - ATC19, Final Round');
  });

  it('falls back to "Round n" when the round numbers could not be read', () => {
    expect(eventSubtitle(event({ round_number: 8 }), null)).toBe('March 4, 2026 - ATC19, Round 8');
  });

  it('uses the category for non-championship events', () => {
    expect(
      eventSubtitle(event({ category: 'exhibition', season_id: null, round_number: null }), finals),
    ).toBe('March 4, 2026 - Exhibition');
    expect(eventSubtitle(event({ category: 'test' }), finals)).toBe('March 4, 2026 - Test');
    expect(eventSubtitle(event({ category: 'iracing' }), finals)).toBe('March 4, 2026 - iRacing');
  });

  it('reads "Championship" for a championship event with no season or round', () => {
    expect(eventSubtitle(event({ round_number: null }), finals)).toBe('March 4, 2026 - Championship');
    expect(eventSubtitle(event({ season_id: null, seasons: null }), finals)).toBe(
      'March 4, 2026 - Championship',
    );
  });
});
