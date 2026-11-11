/**
 * The admin dashboard's latest-event card: the newest round with results in a season, how many of its reports
 * and appeals await the viewer's review, and both windows. One limit=1 read picks the round, then the rest is read for
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
import { countFilters, filterGroupOf, type FilterReport, type ReportFilter } from './incidentReportFilters';

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
  /** "ATC18, Round 8" or "ATC18, Exhibition"; the track goes on its own line beneath (BR5.1). */
  title: string;
  trackName: string;
  /** Reports in the viewer's Needs Review filter on Reported Incidents (BR5.2). */
  incidentsToReview: number;
  /** Open appeals the viewer can read; RLS already hides ones they are involved in (BR5.3). */
  appealsToReview: number;
  submissionWindow: SubmissionWindow;
  submissionClosesAt: Date | null;
  appealWindow: AppealWindow;
  appealClosesAt: Date | null;
}

export type LatestEventResult =
  { state: 'none' } | { state: 'error' } | { state: 'ok'; summary: LatestEventSummary };

/** Who is looking at the dashboard: their reviews and their own car decide what needs their review. */
export interface LatestEventViewer {
  userId: string;
  /** The roster driver linked to this login, or null. */
  driverId: string | null;
}

export interface LatestEventReport extends FilterReport {
  id: string;
  driver_ids: string[];
}

export interface LatestEventInputs {
  round: LatestRound;
  /** The round's display number, or null for an exhibition (computeDisplayRoundNumbers). */
  displayNumber: number | null;
  posting: { posted: boolean; posted_at: string | null } | null;
  reports: LatestEventReport[];
  /** Ids of this round's reports the viewer has reviewed. */
  myReviewedReportIds: ReadonlySet<string>;
  viewerDriverId: string | null;
  appealStatuses: string[];
  reportingWindow: ReportingWindow | null;
  appealPeriodHours: number;
  now: Date;
}

const HOUR_MS = 3_600_000;

/** "1d15h" from one day, else "15h17m" (under an hour "0h12m"); minutes round up (BR5.5). */
export function formatTimeLeft(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return `${days}d${hours}h`;
  }
  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

/** "6 Incidents to Review", singular for exactly one (BR5.6). */
export function toReviewLabel(count: number, noun: 'Incident' | 'Appeal'): string {
  return `${count} ${noun}${count === 1 ? '' : 's'} to Review`;
}

/** "Incidents: 15h17m Remaining" or "Incidents: Closed"; an unknown window reads Closed (BR5.4). */
export function incidentWindowText(state: SubmissionWindow, closesAt: Date | null, now: Date): string {
  if (state === 'open' && closesAt)
    return `Incidents: ${formatTimeLeft(closesAt.getTime() - now.getTime())} Remaining`;
  return 'Incidents: Closed';
}

/** "Appeal: Not Open Yet", "Appeal: 15h17m Remaining" or "Appeal: Closed" (BR5.4). */
export function appealWindowText(state: AppealWindow, closesAt: Date | null, now: Date): string {
  if (state === 'not_posted') return 'Appeal: Not Open Yet';
  if (state === 'open' && closesAt)
    return `Appeal: ${formatTimeLeft(closesAt.getTime() - now.getTime())} Remaining`;
  return 'Appeal: Closed';
}

/** "ATC18, Round 8" or "ATC18, Exhibition" (BR5.1). */
export function latestEventTitle(round: LatestRound, displayNumber: number | null): string {
  const season = round.season_label ? `${round.season_label}, ` : '';
  return `${season}${displayNumber != null ? `Round ${displayNumber}` : 'Exhibition'}`;
}

/** The Report Incident button's rule, and a posted round counts as closed. */
function submissionState(posted: boolean, window: ReportingWindow | null, now: Date): SubmissionWindow {
  if (posted) return 'closed';
  if (!window) return 'unknown';
  return now.getTime() < window.closesUtc.getTime() ? 'open' : 'closed';
}

/** Post time plus the appeal period; posted with no post time is closed, as the site already treats it. */
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

/** The Reported Incidents filter each report falls in for this viewer, by the page's own rule. */
export function reportGroups(
  reports: LatestEventReport[],
  myReviewedReportIds: ReadonlySet<string>,
  viewerDriverId: string | null,
): ReportFilter[] {
  return reports.map((r) =>
    filterGroupOf(r, {
      reviewedByMe: myReviewedReportIds.has(r.id),
      involved: viewerDriverId !== null && r.driver_ids.includes(viewerDriverId),
      reviewsLoadFailed: false,
    }),
  );
}

/** Pure: the card's figures from what the loader read. */
export function summariseLatestEvent(inputs: LatestEventInputs): LatestEventSummary {
  const { round, posting, reportingWindow, now } = inputs;
  const posted = posting?.posted === true;
  const appeal = appealState(posting, inputs.appealPeriodHours, now);
  const groups = reportGroups(inputs.reports, inputs.myReviewedReportIds, inputs.viewerDriverId);
  return {
    subsessionId: round.subsession_id,
    title: latestEventTitle(round, inputs.displayNumber),
    trackName: round.track_name,
    incidentsToReview: countFilters(groups).needs_review,
    appealsToReview: inputs.appealStatuses.filter((s) => s === 'open').length,
    submissionWindow: submissionState(posted, reportingWindow, now),
    submissionClosesAt: reportingWindow?.closesUtc ?? null,
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
  viewer: LatestEventViewer,
  now: Date = new Date(),
): Promise<LatestEventResult> {
  try {
    const round = await getLatestSeasonRound(env);
    if (!round) return { state: 'none' };
    const id = round.subsession_id;
    const [seasonRounds, excluded, posting, reports, myReviews, appeals, events, settings] =
      await Promise.all([
        getRoundsForSeason(env, round.season_id),
        getStandingsExcludedRoundIds(env),
        restGet<{ posted: boolean; posted_at: string | null }[]>(
          env,
          `round_incident_status?select=posted,posted_at&subsession_id=eq.${id}`,
        ),
        restGetAuthed<
          (Omit<LatestEventReport, 'driver_ids'> & { incident_report_drivers: { driver_id: string }[] })[]
        >(
          env,
          accessToken,
          `incident_reports?select=id,status,reviews_closed_at,incident_report_drivers(driver_id)&subsession_id=eq.${id}`,
        ),
        restGetAuthed<{ report_id: string }[]>(
          env,
          accessToken,
          `incident_report_reviews?select=report_id,incident_reports!inner(subsession_id)&reviewer_id=eq.${encodeURIComponent(viewer.userId)}&incident_reports.subsession_id=eq.${id}`,
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
      reports: reports.map(({ incident_report_drivers, ...r }) => ({
        ...r,
        driver_ids: incident_report_drivers.map((d) => d.driver_id),
      })),
      myReviewedReportIds: new Set(myReviews.map((r) => r.report_id)),
      viewerDriverId: viewer.driverId,
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
