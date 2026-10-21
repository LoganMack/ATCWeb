import { LEAGUE_TIME_ZONE } from '../timezone';
import { restDelete, restGet, restPatch, restPost, type SupabaseEnv } from './client';

// --- Events ----------------------------------------------------------------

/** 0050_weather_conditions_expanded.sql — expanded from the original dry/mixed/wet to this more granular set. */
export type Weather = 'clear' | 'partly_cloudy' | 'overcast' | 'raining' | 'mixed';
export type EventFormat = 'endurance' | 'sprint' | 'special';
/**
 * 0035_events_rounds_categories.sql, extended by 0073_holiday_iracing_events.sql.
 * 'championship' (default) expects season_id/round_number; 'test'/'exhibition'
 * are season-agnostic, mirroring the round-level exhibition concept
 * (round_overrides.is_exhibition) at the event level. 'holiday'/'iracing' are
 * also season-agnostic AND circuit-less (see circuit_id/title/subtitle below)
 * — a non-race calendar entry (a holiday, an iRacing-side announcement) that
 * has no track, no sessions, and shouldn't be counted as a race weekend.
 */
export type EventCategory = 'championship' | 'test' | 'exhibition' | 'holiday' | 'iracing';

export interface EventRecord {
  id: string;
  /**
   * Nullable since 0073_holiday_iracing_events.sql — every category except
   * HOLIDAY/IRACING still requires one (enforced by
   * events_circuit_or_title_check); those two have no track at all and use
   * title/subtitle (below) instead.
   */
  circuit_id: string | null;
  layout: string | null;
  event_date: string; // 'YYYY-MM-DD'
  format: EventFormat;
  fuel_limit_pct: number | null;
  results_url: string | null;
  category: EventCategory;
  /**
   * 0073_holiday_iracing_events.sql. Display title for a HOLIDAY/IRACING
   * event, shown in place of the circuit name — required for those two
   * categories (events_circuit_or_title_check), null for every other one,
   * which use circuit_id + the embedded circuits.name instead.
   */
  title: string | null;
  /** 0073_holiday_iracing_events.sql. Optional subtitle for a HOLIDAY/IRACING event, shown in place of the layout name. Null otherwise. */
  subtitle: string | null;
  /** Paired with round_number (both null or both set — enforced by events_season_round_paired). Which round this event represents — matched live against curated_rounds by season_id+round_number, not a stored link. See getEventRound() in results.ts. */
  season_id: string | null;
  round_number: number | null;
  /** Manual override/pin to a specific curated_rounds row — see this column's own comment in 0035_events_rounds_categories.sql for when to use this instead of season_id+round_number auto-matching. */
  subsession_id: number | null;

  practice_start_time: string | null; // 'HH:MM:SS'
  /** In-sim time of day for this session (0023_event_sim_times.sql) — a separate concept from practice_start_time above (that's the real-world/local clock time people need to show up; this is what iRacing's own clock is set to, affecting lighting/weather progression). Same 'HH:MM:SS' shape, no timezone (a sim clock has none). */
  practice_sim_time: string | null;
  practice_minutes: number | null;
  practice_weather: Weather | null;

  qualifying_start_time: string | null;
  qualifying_sim_time: string | null;
  qualifying_minutes: number | null;
  qualifying_laps: number | null;
  qualifying_weather: Weather | null;

  /** Nullable since 0054_test_session_no_race_required.sql — was NOT NULL back when every event was assumed to have at least one scheduled race; a Test Session can now be saved with none. */
  race1_start_time: string | null;
  race1_sim_time: string | null;
  race1_laps: number | null;
  race1_weather: Weather | null;
  /** 0071_race_wet_affected.sql — admin-marked after the fact: did this race actually run wet? Independent of race1_weather (the pre-scheduled forecast). Defaults false, never null. */
  race1_wet_affected: boolean;

  race2_start_time: string | null;
  race2_sim_time: string | null;
  race2_laps: number | null;
  race2_weather: Weather | null;
  race2_wet_affected: boolean;

  race3_start_time: string | null;
  race3_sim_time: string | null;
  race3_laps: number | null;
  race3_weather: Weather | null;
  race3_wet_affected: boolean;
  /** Free-text rules note for this event (0094_events_rules.sql) — shown on the calendar card to the left of the Fuel Limit line (EventDetailCard.astro), editable from the admin event form. Independent of fuel_limit_pct and the ruleset-driven incident limit (that one's read-only, resolved from the season's scoring ruleset — see resolveIncidentLimit). Null when nothing's been entered. */
  rules: string | null;
}

export interface EventWithCircuit extends EventRecord {
  circuits: { name: string; logo_url: string | null } | null;
  /** Embedded from season_id (PostgREST FK join) — null for a season-agnostic TEST/EXHIBITION event, or a championship event that hasn't been assigned a season yet. Just for display ("Round N — ATC17"); the actual round resolution is getEventRound() in results.ts, keyed off season_id/round_number/subsession_id, not this embed. */
  seasons: { name: string; number: number } | null;
}

const EVENT_SELECT =
  'id,circuit_id,layout,event_date,format,fuel_limit_pct,rules,results_url,category,title,subtitle,season_id,round_number,subsession_id,' +
  'practice_start_time,practice_sim_time,practice_minutes,practice_weather,' +
  'qualifying_start_time,qualifying_sim_time,qualifying_minutes,qualifying_laps,qualifying_weather,' +
  'race1_start_time,race1_sim_time,race1_laps,race1_weather,race1_wet_affected,' +
  'race2_start_time,race2_sim_time,race2_laps,race2_weather,race2_wet_affected,' +
  'race3_start_time,race3_sim_time,race3_laps,race3_weather,race3_wet_affected';

/** All events (with circuit name/logo and season name/number embedded), soonest first. Powers the public calendar page. */
export function getEvents(env: SupabaseEnv) {
  const select = `${EVENT_SELECT},circuits(name,logo_url),seasons(name,number)`;
  return restGet<EventWithCircuit[]>(env, `events?select=${encodeURIComponent(select)}&order=event_date.asc`);
}

/**
 * The next `limit` events from today onward — powers the homepage "Upcoming
 * Events" widget. HOLIDAY/IRACING events are deliberately excluded here (per
 * Logan) — that widget is meant to tease the next actual race weekend, and
 * neither category represents one (no track, no sessions). They still show
 * up everywhere else on the full /calendar page — this filter is specific
 * to this one widget's query, not a site-wide visibility rule.
 */
export function getUpcomingEvents(env: SupabaseEnv, limit: number) {
  const select = `${EVENT_SELECT},circuits(name,logo_url),seasons(name,number)`;
  const today = new Date().toISOString().slice(0, 10);
  return restGet<EventWithCircuit[]>(
    env,
    `events?select=${encodeURIComponent(select)}&event_date=gte.${today}&category=not.in.(holiday,iracing)&order=event_date.asc&limit=${limit}`,
  );
}

/**
 * Just the events whose event_date falls within a day of "today" — a
 * narrow, cheap query powering the site-wide "Happening Now" nav banner
 * (src/components/Nav.astro + src/lib/liveEvent.ts), which runs on every
 * single page load and can't afford getEvents()'s full-table fetch just to
 * find whichever 0-1 events might be live right now. The ±1 day pad (rather
 * than exactly "today") covers a session that runs past midnight Eastern,
 * or a request landing right at the UTC/Eastern calendar-date boundary —
 * getEvents() and this both filter on event_date alone, so being a day too
 * generous here just means liveEvent.ts checks one extra, almost-certainly-
 * not-live event, not a correctness problem.
 */
export function getEventsForLiveBanner(env: SupabaseEnv) {
  const select = `${EVENT_SELECT},circuits(name,logo_url),seasons(name,number)`;
  const now = Date.now();
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: LEAGUE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dates = [-1, 0, 1].map((offsetDays) => dayFormatter.format(new Date(now + offsetDays * 86_400_000)));
  return restGet<EventWithCircuit[]>(
    env,
    `events?select=${encodeURIComponent(select)}&event_date=in.(${dates.join(',')})&order=event_date.asc`,
  );
}

export async function getEventById(env: SupabaseEnv, id: string) {
  const events = await restGet<EventRecord[]>(
    env,
    `events?select=${EVENT_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return events[0] ?? null;
}

export function createEvent(env: SupabaseEnv, accessToken: string, data: Partial<EventRecord>) {
  return restPost<EventRecord>(env, accessToken, 'events', data);
}

export function updateEvent(env: SupabaseEnv, accessToken: string, id: string, data: Partial<EventRecord>) {
  return restPatch<EventRecord>(env, accessToken, `events?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteEvent(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `events?id=eq.${encodeURIComponent(id)}`);
}
