import type { EventWithCircuit } from './db/events';
import type { SupabaseEnv } from './db/client';
import { getEventsForLiveBanner } from './db/events';
import { zonedTimeToUtc, LEAGUE_TIME_ZONE } from './timezone';
import { CATEGORY_LABELS } from './eventFormatting';
import { getLayoutBestLapSeconds } from './results/layoutLaps';

/**
 * The "Happening Now" banner under the nav, computed per request from whichever scheduled event contains
 * "now". Schedule-driven only, since results arrive well after a session.
 */
export interface LiveBannerInfo {
  /** "ATC18, Round 4" for a championship event with a season/round on file; the plain category label (Test Session / Exhibition / Holiday / iRacing) for anything else. */
  roundLabel: string;
  /** "Practice" | "Qualifying" | "Race 1" | "Race 2" | "Race 3" */
  sessionLabel: string;
  trackName: string;
  /** Null when the event has no layout/subtitle on file — Nav.astro omits the ", Layout" clause entirely in that case rather than showing a blank. */
  layoutName: string | null;
  /** Server-rendered fallback for no-JS and first paint. Nav.astro's inline script recomputes this client-side every 30s from sessionEndUtcIso instead (same data-attribute-driven pattern as src/scripts/localTime.ts), so it keeps counting down without needing a fresh page load. */
  remainingMinutes: number;
  sessionEndUtcIso: string;
  /** Null means this IS the last scheduled session of the event — Nav.astro renders "Final Session" instead of "Next Session: …" in that case. */
  nextSessionLabel: string | null;
}

interface RawSession {
  label: string;
  startUtc: Date;
  /** Declared length in minutes — practice/qualifying only (see EventRecord's own comment on why races don't have one). Null for races. */
  minutes: number | null;
  /** Scheduled lap count — race1/2/3 only. Only used to ESTIMATE a duration (see getLiveBannerInfo) when this is the final scheduled session of the day; every other session's "end" is just the next session's own start time. */
  laps: number | null;
}

/**
 * Assumed minutes for a live event's final session when nothing better is known (no `minutes` on file, or no
 * lap history at a new track).
 */
const FALLBACK_FINAL_SESSION_MINUTES = 60;

/**
 * Seconds added to the layout's best lap for a race's estimated lap time (Logan), since nobody runs
 * qualifying pace all race.
 */
const RACE_LAP_TIME_BUFFER_SECONDS = 5;

/** Flattens an event's five possible sessions into UTC-anchored, chronologically-sorted entries, skipping any that were never scheduled — self-contained rather than reusing eventFormatting.ts's getEventSessions() since this needs the raw minutes/laps numbers (for duration math), not that function's display-ready formatted strings. */
function buildRawSessions(event: EventWithCircuit): RawSession[] {
  const toUtc = (t: string | null) => (t ? zonedTimeToUtc(event.event_date, t, LEAGUE_TIME_ZONE) : null);
  const sessions: RawSession[] = [];
  const push = (label: string, startTime: string | null, minutes: number | null, laps: number | null) => {
    const startUtc = toUtc(startTime);
    if (startUtc) sessions.push({ label, startUtc, minutes, laps });
  };
  push('Practice', event.practice_start_time, event.practice_minutes, null);
  push('Qualifying', event.qualifying_start_time, event.qualifying_minutes, null);
  push('Race 1', event.race1_start_time, null, event.race1_laps);
  push('Race 2', event.race2_start_time, null, event.race2_laps);
  push('Race 3', event.race3_start_time, null, event.race3_laps);
  return sessions.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
}

function roundLabelFor(event: EventWithCircuit): string {
  if (event.season_id && event.round_number != null && event.seasons) {
    return `ATC${event.seasons.number}, Round ${event.round_number}`;
  }
  return CATEGORY_LABELS[event.category];
}

/**
 * The live event and its current session for the nav banner, or null. The current session is the last one
 * started, and it ends when the next one is scheduled to start, so gaps between sessions keep it live. Only
 * the day's last session uses its declared length or a lap-time estimate. Any failure means no banner.
 */
export async function getLiveBannerInfo(env: SupabaseEnv): Promise<LiveBannerInfo | null> {
  let events: EventWithCircuit[];
  try {
    events = await getEventsForLiveBanner(env);
  } catch (err) {
    console.error('Failed to load events for the "Happening Now" nav banner — banner will be hidden:', err);
    return null;
  }

  const now = Date.now();

  for (const event of events) {
    const sessions = buildRawSessions(event);
    if (sessions.length === 0) continue;

    let idx = -1;
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].startUtc.getTime() <= now) idx = i;
      else break;
    }
    if (idx === -1) continue; // this event hasn't started yet

    const current = sessions[idx];
    const next = sessions[idx + 1] ?? null;

    let endUtcMs: number;
    if (next) {
      endUtcMs = next.startUtc.getTime();
    } else if (current.minutes != null) {
      endUtcMs = current.startUtc.getTime() + current.minutes * 60_000;
    } else if (current.laps != null) {
      let bestLapSeconds: number | null = null;
      try {
        bestLapSeconds = await getLayoutBestLapSeconds(env, event.circuits?.name ?? null, event.layout);
      } catch (err) {
        console.error(
          "Failed to estimate this race's duration from historical lap times — falling back to a flat default:",
          err,
        );
      }
      endUtcMs =
        bestLapSeconds != null
          ? current.startUtc.getTime() + current.laps * (bestLapSeconds + RACE_LAP_TIME_BUFFER_SECONDS) * 1000
          : current.startUtc.getTime() + FALLBACK_FINAL_SESSION_MINUTES * 60_000;
    } else {
      endUtcMs = current.startUtc.getTime() + FALLBACK_FINAL_SESSION_MINUTES * 60_000;
    }

    if (now >= endUtcMs) continue; // this event's window has already passed — check the next candidate event, if any

    return {
      roundLabel: roundLabelFor(event),
      sessionLabel: current.label,
      trackName: event.circuits?.name ?? event.title ?? 'TBD',
      layoutName: event.layout ?? event.subtitle ?? null,
      remainingMinutes: Math.max(0, Math.round((endUtcMs - now) / 60_000)),
      sessionEndUtcIso: new Date(endUtcMs).toISOString(),
      nextSessionLabel: next ? next.label : null,
    };
  }

  return null;
}
