import type { EventCategory, EventFormat, EventRecord, Weather } from './db/events';
import { zonedTimeToUtcIso, LEAGUE_TIME_ZONE } from './timezone';

// Re-exported for components that take a weather value alongside WEATHER_LABELS.
export type { Weather };

/**
 * A bare 'YYYY-MM-DD' given to `new Date()` is UTC midnight and can show as the previous day, so it's built
 * from local components.
 */
function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatEventDate(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', {
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

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  championship: 'Championship',
  test: 'Test Session',
  exhibition: 'Exhibition',
  holiday: 'Holiday',
  iracing: 'iRacing',
};

/**
 * Shared shape for event format/category pills: bold uppercase with one fixed width per size tier
 * ("EXHIBITION" sets it), so tags line up. Colours come from FORMAT_BADGE_CLASSES / CATEGORY_BADGE_CLASSES.
 */
export const EVENT_TAG_CLASSES =
  'inline-flex w-28 flex-none items-center justify-center rounded-lg px-2.5 py-1 text-xs font-bold uppercase tracking-wide';
export const EVENT_TAG_COMPACT_CLASSES =
  'inline-flex w-24 flex-none items-center justify-center rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide';

// Callers only show a category badge when it isn't 'championship'. Test/Holiday/iRacing are neutral grey,
// having no class or format colour; Exhibition is a real raced format outside the points, so it gets all
// three brand colours.
export const CATEGORY_BADGE_CLASSES: Record<EventCategory, string> = {
  championship: '',
  test: 'bg-white/10 text-white/50',
  exhibition:
    'bg-gradient-to-r from-brand-blue/25 via-brand-pink/25 to-brand-gold/25 text-white ring-1 ring-white/10',
  holiday: 'bg-white/10 text-white/50',
  iracing: 'bg-white/10 text-white/50',
};

/**
 * Championship and exhibition are race weekends with a Sprint/Endurance/Special format, so they show a format
 * badge; the rest show their category badge. Shared so every card decides the same way.
 */
export function usesFormatBadge(category: EventCategory): boolean {
  return category === 'championship' || category === 'exhibition';
}

// Background/border accent matching the event's badge colour, only for containers that were already tinted
// (homepage "Next Up", Calendar day cells), not every card.
export const FORMAT_CARD_CLASSES: Record<EventFormat, string> = {
  endurance: 'border-brand-blue/40 bg-brand-blue/10',
  special: 'border-brand-pink/40 bg-brand-pink/10',
  sprint: 'border-brand-gold/40 bg-brand-gold/10',
};

// CATEGORY_BADGE_CLASSES' split as border + background. Exhibition is unreachable via getEventCardClasses()
// (it goes by format) but kept for completeness.
export const CATEGORY_CARD_CLASSES: Record<EventCategory, string> = {
  championship: '',
  test: 'border-white/10 bg-white/[0.03]',
  exhibition:
    'border-white/10 bg-gradient-to-r from-[color:var(--card-blue)] via-[color:var(--card-pink)] to-[color:var(--card-gold)]',
  holiday: 'border-white/10 bg-white/[0.03]',
  iracing: 'border-white/10 bg-white/[0.03]',
};

/** Same format-vs-category branch as usesFormatBadge, applied to the card-background accent above instead of the tag badge. */
export function getEventCardClasses(event: { category: EventCategory; format: EventFormat }): string {
  return usesFormatBadge(event.category)
    ? FORMAT_CARD_CLASSES[event.format]
    : CATEGORY_CARD_CLASSES[event.category];
}

// The card accents plus a hover state, for cards that are links or buttons. Full literal class strings so
// Tailwind finds them.
export const FORMAT_CARD_HOVER_CLASSES: Record<EventFormat, string> = {
  endurance: 'border-brand-blue/40 bg-brand-blue/10 hover:border-brand-blue/60 hover:bg-brand-blue/20',
  special: 'border-brand-pink/40 bg-brand-pink/10 hover:border-brand-pink/60 hover:bg-brand-pink/20',
  sprint: 'border-brand-gold/40 bg-brand-gold/10 hover:border-brand-gold/60 hover:bg-brand-gold/20',
};

export const CATEGORY_CARD_HOVER_CLASSES: Record<EventCategory, string> = {
  championship: '',
  test: 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
  exhibition:
    'border-white/10 bg-gradient-to-r from-[color:var(--card-blue)] via-[color:var(--card-pink)] to-[color:var(--card-gold)] hover:from-[color:var(--card-blue-h)] hover:via-[color:var(--card-pink-h)] hover:to-[color:var(--card-gold-h)]',
  holiday: 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
  iracing: 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
};

/** Same format-vs-category branch as getEventCardClasses, using the hover-inclusive maps above. */
export function getEventCardHoverClasses(event: { category: EventCategory; format: EventFormat }): string {
  return usesFormatBadge(event.category)
    ? FORMAT_CARD_HOVER_CLASSES[event.format]
    : CATEGORY_CARD_HOVER_CLASSES[event.category];
}

export const WEATHER_LABELS: Record<Weather, string> = {
  clear: 'Clear',
  partly_cloudy: 'Partly Cloudy',
  overcast: 'Overcast',
  raining: 'Raining',
  mixed: 'Mixed',
};

export interface SessionSummary {
  label: string;
  startTime: string | null;
  /** `startTime` + the event's date, converted from Eastern (see src/lib/timezone.ts) to a real UTC instant — null whenever startTime is. Render this in a `data-utc-time` attribute (see src/scripts/localTime.ts) so the browser can re-render it in the viewer's own local timezone; the plain `formatSessionTime(startTime)` text remains a same-content Eastern-labeled fallback for no-JS. */
  startTimeUtcIso: string | null;
  /** In-sim time of day for this session (0023_event_sim_times.sql) — the simulated clock time iRacing is set to, separate from startTime (the real-world/local time people need to show up). Null when not set for this session. Deliberately never timezone-converted — a sim clock has no real-world timezone at all. */
  simTime: string | null;
  weather: Weather | null;
  detail: string | null;
}

/** Flattens an event's five possible sessions into a display-ready list, skipping any that were never scheduled. */
export function getEventSessions(event: EventRecord): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  const utcIso = (startTime: string | null) =>
    zonedTimeToUtcIso(event.event_date, startTime, LEAGUE_TIME_ZONE);

  if (event.practice_start_time) {
    sessions.push({
      label: 'Practice',
      startTime: event.practice_start_time,
      startTimeUtcIso: utcIso(event.practice_start_time),
      simTime: event.practice_sim_time,
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
      startTimeUtcIso: utcIso(event.qualifying_start_time),
      simTime: event.qualifying_sim_time,
      weather: event.qualifying_weather,
      detail: parts.length ? parts.join(' / ') : null,
    });
  }

  // Race 1 shows only when it has a start time: test sessions may have no races (0054).
  if (event.race1_start_time) {
    sessions.push({
      label: 'Race 1',
      startTime: event.race1_start_time,
      startTimeUtcIso: utcIso(event.race1_start_time),
      simTime: event.race1_sim_time,
      weather: event.race1_weather,
      detail: event.race1_laps ? `${event.race1_laps} laps` : null,
    });
  }

  if (event.race2_start_time) {
    sessions.push({
      label: 'Race 2',
      startTime: event.race2_start_time,
      startTimeUtcIso: utcIso(event.race2_start_time),
      simTime: event.race2_sim_time,
      weather: event.race2_weather,
      detail: event.race2_laps ? `${event.race2_laps} laps` : null,
    });
  }

  if (event.race3_start_time) {
    sessions.push({
      label: 'Race 3',
      startTime: event.race3_start_time,
      startTimeUtcIso: utcIso(event.race3_start_time),
      simTime: event.race3_sim_time,
      weather: event.race3_weather,
      detail: event.race3_laps ? `${event.race3_laps} laps` : null,
    });
  }

  return sessions;
}
