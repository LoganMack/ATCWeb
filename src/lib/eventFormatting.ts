import type { EventCategory, EventFormat, EventRecord, Weather } from './supabase';
import { zonedTimeToUtcIso, LEAGUE_TIME_ZONE } from './timezone';

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

// Championship is the default/normal case and deliberately gets no special
// treatment here — callers only render a category badge when it's NOT
// 'championship', same "only flag the anomalous state" convention as
// round.status !== 'official' on the Race Results list. Test/Holiday/iRacing
// are all plain neutral grey — none of them belong to a Sprint/Endurance/
// Special format or a driver class, so there's no brand hue that actually
// represents them; grey reads as "informational" rather than implying a
// class/format association that doesn't exist. Exhibition is the one
// exception that still gets a blue/pink/gold gradient — all three brand
// colors at once, since (unlike Test/Holiday/iRacing) it's still a real
// on-track format-having round, just not part of the points championship.
export const CATEGORY_BADGE_CLASSES: Record<EventCategory, string> = {
  championship: '',
  test: 'bg-white/10 text-white/50',
  exhibition: 'bg-gradient-to-r from-brand-blue/25 via-brand-pink/25 to-brand-gold/25 text-white ring-1 ring-white/10',
  holiday: 'bg-white/10 text-white/50',
  iracing: 'bg-white/10 text-white/50',
};

/**
 * Categories that represent an actual on-track race weekend with a
 * Sprint/Endurance/Special format — the only two where a format badge makes
 * sense to render at all. TEST (no format concept — see CATEGORY_LABELS.test
 * above) and the season-agnostic, circuit-less HOLIDAY/IRACING categories all
 * fall through to their own plain category badge instead. Shared here so
 * every card that renders this format-vs-category badge choice (calendar,
 * homepage, admin events list) makes the same call.
 */
export function usesFormatBadge(category: EventCategory): boolean {
  return category === 'championship' || category === 'exhibition';
}

// Card-level background/border accent that mirrors whichever badge color
// getEventCardClasses() below would pick for this event — for the handful
// of containers that already highlight themselves with a tinted background
// (the homepage's featured "Next Up" card, the Calendar view's day cells),
// not the small tag badge itself. Deliberately NOT applied to every event
// card site-wide (e.g. the plain List-view rows on /calendar stay neutral)
// — this is a targeted match for spots that already had a colored
// background, not a general recolor.
export const FORMAT_CARD_CLASSES: Record<EventFormat, string> = {
  endurance: 'border-brand-blue/40 bg-brand-blue/10',
  special: 'border-brand-pink/40 bg-brand-pink/10',
  sprint: 'border-brand-gold/40 bg-brand-gold/10',
};

// Mirrors CATEGORY_BADGE_CLASSES' grey/gradient split, as border+background
// instead of text+background. Exhibition's entry is unreachable through
// getEventCardClasses() below (usesFormatBadge() routes exhibition to
// FORMAT_CARD_CLASSES by format instead, same branch its badge takes) —
// kept filled in for type-completeness and in case a future caller wants
// the category-level gradient directly.
export const CATEGORY_CARD_CLASSES: Record<EventCategory, string> = {
  championship: '',
  test: 'border-white/10 bg-white/[0.03]',
  exhibition: 'border-white/10 bg-gradient-to-r from-brand-blue/10 via-brand-pink/10 to-brand-gold/10',
  holiday: 'border-white/10 bg-white/[0.03]',
  iracing: 'border-white/10 bg-white/[0.03]',
};

/** Same format-vs-category branch as usesFormatBadge, applied to the card-background accent above instead of the tag badge. */
export function getEventCardClasses(event: { category: EventCategory; format: EventFormat }): string {
  return usesFormatBadge(event.category) ? FORMAT_CARD_CLASSES[event.format] : CATEGORY_CARD_CLASSES[event.category];
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
  const utcIso = (startTime: string | null) => zonedTimeToUtcIso(event.event_date, startTime, LEAGUE_TIME_ZONE);

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

  // Race 1 used to always show, back when it was the one required session —
  // Test Session events can now be saved with no races at all
  // (0054_test_session_no_race_required.sql), so this follows the same
  // "only show if it has a start time" rule Race 2/3 already used.
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
