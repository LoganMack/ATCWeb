import { LEAGUE_TIME_ZONE } from '../timezone';
import { restDelete, restGet, restPatch, restPost, type SupabaseEnv } from './client';

// --- Events ----------------------------------------------------------------

/** 0050_weather_conditions_expanded.sql — expanded from the original dry/mixed/wet to this more granular set. */
export type Weather = 'clear' | 'partly_cloudy' | 'overcast' | 'raining' | 'mixed';
export type EventFormat = 'endurance' | 'sprint' | 'special';
/**
 * 0035, extended by 0073. 'championship' expects season_id/round_number; 'test'/'exhibition' are
 * season-agnostic; 'holiday'/'iracing' are also circuit-less non-race entries that never count as a race
 * weekend.
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
  /**
   * Paired with round_number (events_season_round_paired). The round is matched live against curated_rounds,
   * not stored; see getEventRound() in src/lib/results/rounds.ts.
   */
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
  /** Free-text rules note (in the baseline schema), shown left of the Fuel Limit on calendar cards; independent of the ruleset's incident limit. */
  rules: string | null;
}

export interface EventWithCircuit extends EventRecord {
  circuits: { name: string; logo_url: string | null } | null;
  /**
   * Embedded season, for display only ("Round N — ATC17"); null for test/exhibition or an unassigned event.
   * Round resolution is getEventRound() in src/lib/results/rounds.ts.
   */
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
 * The next `limit` events from today, for the homepage widget. HOLIDAY/IRACING events are left out here only,
 * since the widget teases the next race weekend (Logan).
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
 * Events within a day of today, for the "Happening Now" banner on every page, which can't afford getEvents()'
 * full fetch. The ±1 day pad covers sessions past midnight Eastern and the UTC/Eastern date boundary.
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
