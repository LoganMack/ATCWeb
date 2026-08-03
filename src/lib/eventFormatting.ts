import type { EventFormat, EventRecord, Weather } from './supabase';

/**
 * `event_date` comes back from PostgREST as a plain 'YYYY-MM-DD' string with
 * no time/zone info. Parsing it with `new Date('YYYY-MM-DD')` treats it as
 * UTC midnight, which can render as the *previous* day once
 * `toLocaleDateString` applies a negative-offset local timezone. Building
 * the Date from its local year/month/day components instead sidesteps that
 * entirely.
 */
function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatEventDate(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatEventDateShort(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** '14:30:00' (or '14:30') -> '2:30 PM'. */
export function formatSessionTime(timeStr: string | null): string | null {
  if (!timeStr) return null;
  const [hoursStr, minutesStr] = timeStr.split(':');
  const date = new Date(2000, 0, 1, Number(hoursStr), Number(minutesStr));
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export const FORMAT_LABELS: Record<EventFormat, string> = {
  endurance: 'Endurance',
  sprint: 'Sprint',
  special: 'Special',
};

// Format colors follow the same blue/pink/gold hierarchy as the driver
// classes (Alpha/Gamma/Delta) — endurance=blue, special=pink, sprint=gold.
export const FORMAT_BADGE_CLASSES: Record<EventFormat, string> = {
  endurance: 'bg-brand-blue/15 text-brand-blue',
  special: 'bg-brand-pink/15 text-brand-pink',
  sprint: 'bg-brand-gold/15 text-brand-gold',
};

export const WEATHER_LABELS: Record<Weather, string> = {
  dry: 'Dry',
  mixed: 'Mixed',
  wet: 'Wet',
};

export interface SessionSummary {
  label: string;
  startTime: string | null;
  weather: Weather | null;
  detail: string | null;
}

/** Flattens an event's five possible sessions into a display-ready list, skipping any that were never scheduled. */
export function getEventSessions(event: EventRecord): SessionSummary[] {
  const sessions: SessionSummary[] = [];

  if (event.practice_start_time) {
    sessions.push({
      label: 'Practice',
      startTime: event.practice_start_time,
      weather: event.practice_weather,
      detail: event.practice_minutes ? `${event.practice_minutes} min` : null,
    });
  }

  if (event.qualifying_start_time) {
    const parts: string[] = [];
    if (event.qualifying_minutes) parts.push(`${event.qualifying_minutes} min`);
    if (event.qualifying_laps) parts.push(`${event.qualifying_laps} laps`);
    sessions.push({
      label: 'Qualifying',
      startTime: event.qualifying_start_time,
      weather: event.qualifying_weather,
      detail: parts.length ? parts.join(' / ') : null,
    });
  }

  // Race 1 always shows — it's the one required session.
  sessions.push({
    label: 'Race 1',
    startTime: event.race1_start_time,
    weather: event.race1_weather,
    detail: event.race1_laps ? `${event.race1_laps} laps` : null,
  });

  if (event.race2_start_time) {
    sessions.push({
      label: 'Race 2',
      startTime: event.race2_start_time,
      weather: event.race2_weather,
      detail: event.race2_laps ? `${event.race2_laps} laps` : null,
    });
  }

  if (event.race3_start_time) {
    sessions.push({
      label: 'Race 3',
      startTime: event.race3_start_time,
      weather: event.race3_weather,
      detail: event.race3_laps ? `${event.race3_laps} laps` : null,
    });
  }

  return sessions;
}
