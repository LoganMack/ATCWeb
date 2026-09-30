/**
 * Driver-submitted incident reports (0090_incident_reports.sql) — the
 * reporting-window math plus the small DB helpers the results page and the
 * steward-facing incidents page share.
 *
 * REPORTING WINDOW (per Logan): a round's reports stay open for 24 hours
 * after the race is "over", where over means
 *   - lap-limited races:  1.5 hours after the attached event's Race 1 start
 *   - time-limited races: 30 minutes after the FINAL race's time expires
 *
 * The events table has no race-length-in-minutes column (only race*_laps),
 * so the time-limited branch can't read a real duration yet: a final race
 * with no lap count is treated as running TIME_LIMITED_RACE_ASSUMED_MINUTES
 * from its own start. Once race-minutes fields exist, only `raceEndUtc`
 * below needs to change.
 */

import {
  restGet,
  restGetAuthed,
  restPatch,
  getSiteSettings,
  type SupabaseEnv,
} from './supabase';
import { siteSettingInt, INCIDENT_REPORT_PERIOD_HOURS_KEY } from './siteSettings';
import { zonedTimeToUtc, LEAGUE_TIME_ZONE } from './timezone';

export const LAP_LIMITED_RACE_OVER_MINUTES = 90;
export const TIME_LIMITED_POST_RACE_MINUTES = 30;
export const TIME_LIMITED_RACE_ASSUMED_MINUTES = 60;
/** Default reporting-period length — the live value is the `incident_report_period_hours` site setting (admin > Site Properties); see getReportingPeriodHours. */
export const REPORTING_WINDOW_HOURS = 24;

interface WindowEvent {
  event_date: string;
  race1_start_time: string | null;
  race1_laps: number | null;
  race2_start_time: string | null;
  race2_laps: number | null;
  race3_start_time: string | null;
  race3_laps: number | null;
}

const EVENT_WINDOW_SELECT =
  'event_date,race1_start_time,race1_laps,race2_start_time,race2_laps,race3_start_time,race3_laps';

export interface ReportingWindow {
  /** When the race is considered over (UTC). */
  raceOverUtc: Date;
  /** When reporting closes (UTC) — raceOverUtc + 24h. */
  closesUtc: Date;
}

/** Pure — computes the window from an event (or, with no usable event, the round's own start time). */
export function computeReportingWindow(
  event: WindowEvent | null,
  roundStartTimeIso: string | null,
  periodHours: number = REPORTING_WINDOW_HOURS
): ReportingWindow | null {
  let raceOver: Date | null = null;

  if (event) {
    const races = [
      { start: event.race1_start_time, laps: event.race1_laps },
      { start: event.race2_start_time, laps: event.race2_laps },
      { start: event.race3_start_time, laps: event.race3_laps },
    ]
      .map((r) => ({ startUtc: r.start ? zonedTimeToUtc(event.event_date, r.start, LEAGUE_TIME_ZONE) : null, laps: r.laps }))
      .filter((r): r is { startUtc: Date; laps: number | null } => r.startUtc !== null);

    if (races.length > 0) {
      const first = races[0];
      const last = races[races.length - 1];
      if (first.laps !== null || last.laps !== null) {
        // Lap-limited: 1.5h from Race 1's start.
        raceOver = new Date(first.startUtc.getTime() + LAP_LIMITED_RACE_OVER_MINUTES * 60_000);
      } else {
        // Time-limited: final race's expiry (assumed length, see header) + 30 min.
        raceOver = new Date(
          last.startUtc.getTime() + (TIME_LIMITED_RACE_ASSUMED_MINUTES + TIME_LIMITED_POST_RACE_MINUTES) * 60_000
        );
      }
    }
  }

  if (!raceOver && roundStartTimeIso) {
    const start = new Date(roundStartTimeIso);
    if (!Number.isNaN(start.getTime())) {
      raceOver = new Date(start.getTime() + LAP_LIMITED_RACE_OVER_MINUTES * 60_000);
    }
  }
  if (!raceOver) return null;
  return { raceOverUtc: raceOver, closesUtc: new Date(raceOver.getTime() + periodHours * 3_600_000) };
}

/** Reports open once the race is over is NOT required — a driver can report from practice onward; only the closing edge is enforced. */
export function isReportingOpen(window: ReportingWindow | null, now: Date = new Date()): boolean {
  if (!window) return false;
  return now.getTime() < window.closesUtc.getTime();
}

/** Resolves a round's attached event (curated_rounds.event_id, else events.subsession_id) and computes its window. */
export async function getReportingWindowForRound(
  env: SupabaseEnv,
  subsessionId: number,
  roundStartTimeIso: string | null,
  periodHours: number = REPORTING_WINDOW_HOURS
): Promise<ReportingWindow | null> {
  let event: WindowEvent | null = null;
  try {
    const rounds = await restGet<{ event_id: string | null }[]>(
      env,
      `curated_rounds?select=event_id&subsession_id=eq.${subsessionId}`
    );
    const eventId = rounds[0]?.event_id ?? null;
    const path = eventId
      ? `events?select=${EVENT_WINDOW_SELECT}&id=eq.${eventId}`
      : `events?select=${EVENT_WINDOW_SELECT}&subsession_id=eq.${subsessionId}`;
    event = (await restGet<WindowEvent[]>(env, path))[0] ?? null;
  } catch (err) {
    console.error('Failed to look up the attached event for the reporting window:', err);
  }
  return computeReportingWindow(event, roundStartTimeIso, periodHours);
}

/** The configured reporting-period length in hours (site setting, default 24). Never throws — a failed settings read just means the default. */
export async function getReportingPeriodHours(env: SupabaseEnv): Promise<number> {
  try {
    return siteSettingInt(await getSiteSettings(env), INCIDENT_REPORT_PERIOD_HOURS_KEY);
  } catch (err) {
    console.error('Failed to read the incident reporting period setting:', err);
    return REPORTING_WINDOW_HOURS;
  }
}

// --- Posted flag (0092_incident_posting.sql) -----------------------------------

/** Whether stewards have posted this round's incident report (making its page public). No row = not posted. */
export async function isRoundPosted(env: SupabaseEnv, subsessionId: number): Promise<boolean> {
  try {
    const rows = await restGet<{ posted: boolean }[]>(env, `round_incident_status?select=posted&subsession_id=eq.${subsessionId}`);
    return rows[0]?.posted === true;
  } catch (err) {
    console.error('Failed to read the round incident posted flag:', err);
    return false;
  }
}

/** Every posted round's subsession id. */
export async function getPostedSubsessionIds(env: SupabaseEnv): Promise<Set<number>> {
  const rows = await restGet<{ subsession_id: number }[]>(env, 'round_incident_status?select=subsession_id&posted=eq.true');
  return new Set(rows.map((r) => r.subsession_id));
}

/** Admin: post/unpost a round's incident report. */
export async function setRoundPosted(env: SupabaseEnv, accessToken: string, subsessionId: number, posted: boolean): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/round_incident_status?on_conflict=subsession_id`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ subsession_id: subsessionId, posted }),
  });
  if (!res.ok) throw new Error(`Supabase upsert error ${res.status} on round_incident_status: ${await res.text()}`);
}

/**
 * Hover text for the results page's "Report Incident" button while the
 * period is open: "Incident reporting period ends in X hours." — switching
 * to minutes once 2 hours or less remain. (IncidentButton.astro's inline
 * script recomputes the same text live client-side, so a cached page stays right.)
 */
export function reportingCountdownText(closesUtc: Date, now: Date = new Date()): string {
  const ms = closesUtc.getTime() - now.getTime();
  if (ms <= 0) return 'The incident reporting period has ended.';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 120) return `Incident reporting period ends in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const hours = Math.floor(ms / 3_600_000);
  return `Incident reporting period ends in ${hours} hours.`;
}

// --- DB helpers ------------------------------------------------------------

export interface IncidentReport {
  id: string;
  subsession_id: number;
  session: string;
  lap: number;
  turn: string;
  description: string | null;
  /** Null for a report from a signed-out visitor. */
  reporter_id: string | null;
  reporter_name: string | null;
  status: 'open' | 'logged' | 'dismissed';
  created_at: string;
  driver_ids: string[];
}

export interface NewIncidentReport {
  subsession_id: number;
  session: string;
  lap: number;
  turn: string;
  description: string | null;
  driver_ids: string[];
}

/**
 * Open to signed-out visitors: goes through the submit_incident_report
 * SECURITY DEFINER function (0091), which validates the input and derives
 * the reporter from the caller's JWT (null when `accessToken` is omitted —
 * the anon key is used instead). Throws on any failure.
 */
export async function createIncidentReport(env: SupabaseEnv, accessToken: string | null, input: NewIncidentReport): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/submit_incident_report`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken ?? env.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_subsession_id: input.subsession_id,
      p_session: input.session,
      p_lap: input.lap,
      p_turn: input.turn,
      p_description: input.description,
      p_driver_ids: input.driver_ids,
    }),
  });
  if (!res.ok) throw new Error(`Supabase rpc error ${res.status} on submit_incident_report: ${await res.text()}`);
}

/** Admin (or own-reporter) read — RLS filters to whatever the token may see. */
export async function getIncidentReportsForSubsession(
  env: SupabaseEnv,
  accessToken: string,
  subsessionId: number
): Promise<IncidentReport[]> {
  const rows = await restGetAuthed<(Omit<IncidentReport, 'driver_ids'> & { incident_report_drivers: { driver_id: string }[] })[]>(
    env,
    accessToken,
    `incident_reports?select=*,incident_report_drivers(driver_id)&subsession_id=eq.${subsessionId}&order=created_at.asc`
  );
  return rows.map(({ incident_report_drivers, ...r }) => ({
    ...r,
    driver_ids: incident_report_drivers.map((d) => d.driver_id),
  }));
}

export async function setIncidentReportStatus(
  env: SupabaseEnv,
  accessToken: string,
  reportId: string,
  status: 'open' | 'logged' | 'dismissed'
): Promise<void> {
  await restPatch(env, accessToken, `incident_reports?id=eq.${encodeURIComponent(reportId)}`, { status });
}
