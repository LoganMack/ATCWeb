/**
 * "To Be Determined" events: a championship, exhibition or test event put on the calendar before its circuit
 * is known (20261116120000_events_tbd_circuit.sql). Nothing extra is stored; an event is TBD when it has no
 * circuit and is not a holiday or iRacing event, which never have one.
 */
import type { EventRecord } from './db/events';

/** The circuit select's value for "To Be Determined"; never a circuit id. */
export const TBD_CIRCUIT_VALUE = 'tbd';

/** What public pages call an event whose circuit is not known yet. */
export const TBD_LABEL = 'TBD';

export function isTbdEvent(event: { circuit_id?: string | null; category?: string | null }): boolean {
  return !event.circuit_id && event.category !== 'holiday' && event.category !== 'iracing';
}

/**
 * Clears everything that depends on the venue, so a TBD event never carries a stale start time (which would
 * also trigger the race reminder email) or a layout from another circuit. Format keeps the column's default,
 * hidden on display. Title, subtitle, date, season, round and subsession are kept as entered.
 */
export function applyTbd(data: Partial<EventRecord>): Partial<EventRecord> {
  return {
    ...data,
    circuit_id: null,
    layout: null,
    format: 'sprint',
    fuel_limit_pct: null,
    rules: null,
    results_url: null,
    practice_start_time: null,
    practice_sim_time: null,
    practice_minutes: null,
    practice_weather: null,
    practice_wet_affected: false,
    qualifying_start_time: null,
    qualifying_sim_time: null,
    qualifying_minutes: null,
    qualifying_laps: null,
    qualifying_weather: null,
    qualifying_wet_affected: false,
    race1_start_time: null,
    race1_sim_time: null,
    race1_laps: null,
    race1_weather: null,
    race1_wet_affected: false,
    race2_start_time: null,
    race2_sim_time: null,
    race2_laps: null,
    race2_weather: null,
    race2_wet_affected: false,
    race3_start_time: null,
    race3_sim_time: null,
    race3_laps: null,
    race3_weather: null,
    race3_wet_affected: false,
  };
}
