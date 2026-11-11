/** "To Be Determined" events (FR4; BR4.3, BR4.4, BR4.6): which events are TBD, and what a TBD save clears. */
import { describe, expect, it } from 'vitest';
import { applyTbd, isTbdEvent, TBD_CIRCUIT_VALUE } from '../../src/lib/eventTbd';
import type { EventRecord } from '../../src/lib/db/events';

describe('isTbdEvent', () => {
  it('is true for championship, exhibition and test events without a circuit', () => {
    expect(isTbdEvent({ circuit_id: null, category: 'championship' })).toBe(true);
    expect(isTbdEvent({ circuit_id: null, category: 'exhibition' })).toBe(true);
    expect(isTbdEvent({ circuit_id: null, category: 'test' })).toBe(true);
  });

  it('is never true for holiday or iRacing events, which have no circuit by design', () => {
    expect(isTbdEvent({ circuit_id: null, category: 'holiday' })).toBe(false);
    expect(isTbdEvent({ circuit_id: null, category: 'iracing' })).toBe(false);
  });

  it('is false once the event has a circuit', () => {
    expect(isTbdEvent({ circuit_id: 'circuit-1', category: 'championship' })).toBe(false);
  });

  it('uses a select value that can never be a circuit id (a uuid)', () => {
    expect(TBD_CIRCUIT_VALUE).toBe('tbd');
  });
});

describe('applyTbd', () => {
  const entered: Partial<EventRecord> = {
    circuit_id: 'tbd',
    layout: 'Grand Prix',
    title: null,
    subtitle: null,
    event_date: '2026-12-06',
    format: 'endurance',
    fuel_limit_pct: 30,
    rules: 'Fixed setup',
    results_url: 'https://members.iracing.com/x',
    category: 'championship',
    season_id: 'season-19',
    round_number: 2,
    subsession_id: 123,
    practice_start_time: '19:00',
    practice_sim_time: '13:00',
    practice_minutes: 20,
    practice_weather: 'clear',
    qualifying_start_time: '19:20',
    qualifying_laps: 2,
    race1_start_time: '19:30',
    race1_laps: 20,
    race1_weather: 'raining',
    race1_wet_affected: true,
    race2_start_time: '20:15',
    race3_start_time: '21:00',
  };

  it('clears the circuit, layout, fuel limit, rules and iRacing URL, and saves format as sprint', () => {
    const out = applyTbd(entered);
    expect(out.circuit_id).toBeNull();
    expect(out.layout).toBeNull();
    expect(out.fuel_limit_pct).toBeNull();
    expect(out.rules).toBeNull();
    expect(out.results_url).toBeNull();
    expect(out.format).toBe('sprint');
  });

  it('clears every session time, so no race reminder is scheduled', () => {
    const out = applyTbd(entered);
    for (const key of [
      'practice_start_time',
      'qualifying_start_time',
      'race1_start_time',
      'race2_start_time',
      'race3_start_time',
      'practice_sim_time',
      'practice_minutes',
      'practice_weather',
      'qualifying_laps',
      'race1_laps',
      'race1_weather',
    ] as const) {
      expect(out[key], key).toBeNull();
    }
    expect(out.race1_wet_affected).toBe(false);
  });

  it('keeps the date, category, season, round and subsession as entered', () => {
    const out = applyTbd(entered);
    expect(out.event_date).toBe('2026-12-06');
    expect(out.category).toBe('championship');
    expect(out.season_id).toBe('season-19');
    expect(out.round_number).toBe(2);
    expect(out.subsession_id).toBe(123);
  });
});
