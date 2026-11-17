/**
 * The Incident Report header: its subtitle and whether the Post Report button can be pressed yet. Pure, so the
 * page and the tests share one rule.
 */
import { formatDateShort } from './db/circuits';
import type { SupabaseEnv } from './db/client';
import {
  getReportingPeriodHours,
  getReportingWindowForRound,
  isReportingOpen,
  type ReportingWindow,
} from './incidentReports';
import { seasonRoundLabel } from './roundLabels';

/**
 * "Nov 16, 2026 - ATC18, Round 8": the round's date, then its season and displayed round number. A round with
 * no number reads "… - ATC18, Exhibition"; a round with no season shows the date alone.
 */
export function incidentSubtitle(
  startTime: string,
  seasonLabel: string | null | undefined,
  displayRoundNumber: number | null | undefined,
): string {
  const date = formatDateShort(startTime);
  return seasonLabel?.trim() ? `${date} - ${seasonRoundLabel(seasonLabel, displayRoundNumber)}` : date;
}

export type PostReportState = 'enabled' | 'disabled';

/**
 * Post Report waits while drivers can still submit incidents. With no known window (no attached event and no
 * start time) nothing is holding the report back, so the button is live.
 */
export function postReportState(window: ReportingWindow | null, now: Date = new Date()): PostReportState {
  return window && isReportingOpen(window, now) ? 'disabled' : 'enabled';
}

/** Whether Post Report must wait, read fresh: the post handler re-checks what the page's button showed. */
export async function incidentReportBlocked(
  env: SupabaseEnv,
  subsessionId: number,
  roundStartTime: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const hours = await getReportingPeriodHours(env);
  const window = await getReportingWindowForRound(env, subsessionId, roundStartTime, hours);
  return postReportState(window, now) === 'disabled';
}
