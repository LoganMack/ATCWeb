/**
 * The homepage event line (FR11.2-FR11.4; BR11.1): the long date plus "ATCn, Round n", "ATCn, Final Round" or
 * the event's category, e.g. "March 4, 2026 - ATC19, Round 3".
 */
import type { EventCategory, EventRoundNumber } from './db/events';
import { formatEventDate } from './eventFormatting';

/** Category labels on this line ("Test", not the calendar badge's "Test Session"). */
export const SUBTITLE_CATEGORY_LABELS: Record<EventCategory, string> = {
  championship: 'Championship',
  exhibition: 'Exhibition',
  test: 'Test',
  holiday: 'Holiday',
  iracing: 'iRacing',
};

/**
 * Each season's highest championship round number among its events, TBD events included (BR11.1). The
 * caller passes null when the read failed, which drops the "Final Round" label but keeps the rest.
 */
export function finalRoundNumbers(rows: EventRoundNumber[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.season_id || row.round_number === null || row.round_number === undefined) continue;
    out.set(row.season_id, Math.max(out.get(row.season_id) ?? 0, row.round_number));
  }
  return out;
}

export interface SubtitleEvent {
  event_date: string;
  category: EventCategory;
  season_id: string | null;
  round_number: number | null;
  seasons: { name: string } | null;
}

/** "<Month D, YYYY> - <SeasonName>, Round <n>" (or ", Final Round"), else "<Month D, YYYY> - <Category>". */
export function eventSubtitle(event: SubtitleEvent, finalRounds: Map<string, number> | null): string {
  const date = formatEventDate(event.event_date);
  const seasonName = event.seasons?.name?.trim();
  if (event.category === 'championship' && event.season_id && seasonName && event.round_number) {
    const isFinal = finalRounds?.get(event.season_id) === event.round_number;
    return `${date} - ${seasonName}, ${isFinal ? 'Final Round' : `Round ${event.round_number}`}`;
  }
  return `${date} - ${SUBTITLE_CATEGORY_LABELS[event.category] ?? 'Championship'}`;
}
