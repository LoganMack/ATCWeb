/**
 * The admin dashboard's latest-event card (BR5.3-BR5.11): the newest round with results in a season, its
 * submissions and appeals, and both windows. One limit=1 read picks the round, then the rest is read for
 * that one round only (Free plan egress). Reports and appeals use the signed-in token, so RLS decides.
 */
import { restGet, restGetAuthed, type SupabaseEnv } from './db/client';
import { getSiteSettings } from './db/assets';
import { getStandingsExcludedRoundIds } from './db/rounds';
import { computeDisplayRoundNumbers, getRoundsForSeason } from './results/rounds';
import {
  computeReportingWindow,
  EVENT_WINDOW_SELECT,
  type ReportingWindow,
  type WindowEvent,
} from './incidentReports';
import {
  INCIDENT_APPEAL_PERIOD_HOURS_KEY,
  INCIDENT_REPORT_PERIOD_HOURS_KEY,
  siteSettingInt,
} from './siteSettings';

export interface LatestRound {
  subsession_id: number;
  season_id: string;
  season_label: string | null;
  start_time: string;
  track_name: string;
  event_id: string | null;
}

export type SubmissionWindow = 'open' | 'closed' | 'unknown';
export type AppealWindow = 'not_posted' | 'open' | 'closed';

export interface LatestEventSummary {
  subsessionId: number;
  label: string;
  submissionsTotal: number;
  submissionsOpen: number;
  submissionWindow: SubmissionWindow;
  submissionClosesAt: Date | null;
  appealsTotal: number;
  appealsOpen: number;
  appealWindow: AppealWindow;
  appealClosesAt: Date | null;
}

export type LatestEventResult =
  { state: 'none' } | { state: 'error' } | { state: 'ok'; summary: LatestEventSummary };

export interface LatestEventInputs {
  round: LatestRound;
  /** The round's display number, or null for an exhibition (computeDisplayRoundNumbers). */
  displayNumber: number | null;
  posting: { posted: boolean; posted_at: string | null } | null;
  reportStatuses: string[];
  appealStatuses: string[];
  reportingWindow: ReportingWindow | null;
  appealPeriodHours: number;
  now: Date;
}

const HOUR_MS = 3_600_000;

/** "2 d 3 h" from one day, else "5 h 12 m", else "12 m"; minutes round up, so a whole hour reads "5 h 0 m" (BR5.9). */
export function formatTimeLeft(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return `${days} d ${hours} h`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} m` : `${minutes} m`;
}

/** "7 submissions (2 open)", singular for exactly one (BR5.5, BR5.6). */
export function countLabel(total: number, open: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'} (${open} open)`;
}

export function submissionWindowText(state: SubmissionWindow, closesAt: Date | null, now: Date): string {
  if (state === 'unknown') return 'Unknown';
  if (state === 'open' && closesAt) return `Closes in ${formatTimeLeft(closesAt.getTime() - now.getTime())}`;
  return 'Closed';
}

export function appealWindowText(state: AppealWindow, closesAt: Date | null, now: Date): string {
  if (state === 'not_posted') return 'Opens when posted';
  if (state === 'open' && closesAt) return `Closes in ${formatTimeLeft(closesAt.getTime() - now.getTime())}`;
  return 'Closed';
}

/** "ATC18, Round 8: Sonoma Raceway" or "ATC18, Exhibition: Sonoma Raceway" (BR5.4). */
export function latestEventLabel(round: LatestRound, displayNumber: number | null): string {
  const season = round.season_label ? `${round.season_label}, ` : '';
  const name = displayNumber != null ? `Round ${displayNumber}` : 'Exhibition';
  return `${season}${name}: ${round.track_name}`;
}

/** The Report Incident button's rule, and a posted round counts as closed (BR5.7). */
function submissionState(posted: boolean, window: ReportingWindow | null, now: Date): SubmissionWindow {
  if (posted) return 'closed';
  if (!window) return 'unknown';
  return now.getTime() < window.closesUtc.getTime() ? 'open' : 'closed';
}

/** Post time plus the appeal period; posted with no post time is closed, as the site already treats it (BR5.8). */
function appealState(
  posting: LatestEventInputs['posting'],
  periodHours: number,
  now: Date,
): { state: AppealWindow; closesAt: Date | null } {
  if (!posting?.posted) return { state: 'not_posted', closesAt: null };
  const postedAt = posting.posted_at ? new Date(posting.posted_at) : null;
  if (!postedAt || Number.isNaN(postedAt.getTime())) return { state: 'closed', closesAt: null };
  const closesAt = new Date(postedAt.getTime() + periodHours * HOUR_MS);
  return { state: now.getTime() < closesAt.getTime() ? 'open' : 'closed', closesAt };
}

/** Pure: the card's figures from what the loader read. */
export function summariseLatestEvent(inputs: LatestEventInputs): LatestEventSummary {
  const { round, posting, reportingWindow, now } = inputs;
  const posted = posting?.posted === true;
  const appeal = appealState(posting, inputs.appealPeriodHours, now);
  return {
    subsessionId: round.subsession_id,
    label: latestEventLabel(round, inputs.displayNumber),
    submissionsTotal: inputs.reportStatuses.length,
    submissionsOpen: inputs.reportStatuses.filter((s) => s === 'open').length,
    submissionWindow: submissionState(posted, reportingWindow, now),
    submissionClosesAt: reportingWindow?.closesUtc ?? null,
    appealsTotal: inputs.appealStatuses.length,
    appealsOpen: inputs.appealStatuses.filter((s) => s === 'open').length,
    appealWindow: appeal.state,
    appealClosesAt: appeal.closesAt,
  };
}

const LATEST_ROUND_SELECT = 'subsession_id,season_id,season_label,start_time,track_name,event_id';

/** The newest round with results that belongs to a season, ties by the higher subsession id (BR5.3). */
async function getLatestSeasonRound(env: SupabaseEnv): Promise<LatestRound | null> {
  const rows = await restGet<LatestRound[]>(
    env,
    `curated_rounds?select=${LATEST_ROUND_SELECT}&season_id=not.is.null&order=start_time.desc,subsession_id.desc&limit=1`,
  );
  return rows[0] ?? null;
}

/** Same lookup as getReportingWindowForRound: the attached event by id, else by subsession id. */
function getWindowEvent(env: SupabaseEnv, round: LatestRound): Promise<WindowEvent[]> {
  const filter = round.event_id
    ? `id=eq.${encodeURIComponent(round.event_id)}`
    : `subsession_id=eq.${round.subsession_id}`;
  return restGet<WindowEvent[]>(env, `events?select=${EVENT_WINDOW_SELECT}&${filter}`);
}

/** Loads and summarises the card. Never throws: a failed read is logged and gives the 'error' state (BR5.10). */
export async function getLatestEventSummary(
  env: SupabaseEnv,
  accessToken: string,
  now: Date = new Date(),
): Promise<LatestEventResult> {
  try {
    const round = await getLatestSeasonRound(env);
    if (!round) return { state: 'none' };
    const id = round.subsession_id;
    const [seasonRounds, excluded, posting, reports, appeals, events, settings] = await Promise.all([
      getRoundsForSeason(env, round.season_id),
      getStandingsExcludedRoundIds(env),
      restGet<{ posted: boolean; posted_at: string | null }[]>(
        env,
        `round_incident_status?select=posted,posted_at&subsession_id=eq.${id}`,
      ),
      restGetAuthed<{ status: string }[]>(
        env,
        accessToken,
        `incident_reports?select=status&subsession_id=eq.${id}`,
      ),
      restGetAuthed<{ status: string }[]>(
        env,
        accessToken,
        `incident_appeals?select=status&subsession_id=eq.${id}`,
      ),
      getWindowEvent(env, round),
      getSiteSettings(env),
    ]);
    const displayNumber = computeDisplayRoundNumbers(seasonRounds, excluded, new Set()).get(id) ?? null;
    const reportingWindow = computeReportingWindow(
      events[0] ?? null,
      round.start_time,
      siteSettingInt(settings, INCIDENT_REPORT_PERIOD_HOURS_KEY),
    );
    const summary = summariseLatestEvent({
      round,
      displayNumber,
      posting: posting[0] ?? null,
      reportStatuses: reports.map((r) => r.status),
      appealStatuses: appeals.map((a) => a.status),
      reportingWindow,
      appealPeriodHours: siteSettingInt(settings, INCIDENT_APPEAL_PERIOD_HOURS_KEY),
      now,
    });
    return { state: 'ok', summary };
  } catch (err) {
    console.error('Failed to load the latest event summary:', err);
    return { state: 'error' };
  }
}
