/**
 * Whether a round is a test or exhibition round (FR6.4.1), for the Series iRating timeline and the past
 * results and incidents. A round is excluded when its override flags say so or its event is in an excluded
 * category; either source is enough. Pure: callers pass the override set from `getStandingsExcludedRoundIds`,
 * whose failure they let reach their error state, so a round is never shown because a read failed.
 * The standings keep their own reader.
 */

export const EXCLUDED_EVENT_CATEGORIES = ['test', 'exhibition'] as const;

export type EligibilityRound = { subsession_id: number; event_category: string | null };

export type RoundEventEmbed = {
  event: { category: string } | null;
  pinned_events: { category: string }[] | null;
};

/**
 * Appended to a caller's existing `curated_rounds` select. The FK hints are required: the tables are joined
 * both ways, so a plain `events(...)` embed is ambiguous and refused.
 */
export const ROUND_EVENT_CATEGORY_SELECT =
  'event:events!curated_rounds_event_id_fkey(category),pinned_events:events!events_subsession_id_fkey(category)';

function isExcludedCategory(category: string | null | undefined): boolean {
  if (typeof category !== 'string') return false;
  const key = category.trim().toLowerCase();
  return (EXCLUDED_EVENT_CATEGORIES as readonly string[]).includes(key);
}

export function isExcludedRound(round: EligibilityRound, overrideIds: ReadonlySet<number>): boolean {
  return overrideIds.has(round.subsession_id) || isExcludedCategory(round.event_category);
}

/** The ids among `rounds` that are excluded, as a new Set; inputs are not changed. */
export function excludedRoundIds(
  rounds: readonly EligibilityRound[],
  overrideIds: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  for (const round of rounds) if (isExcludedRound(round, overrideIds)) out.add(round.subsession_id);
  return out;
}

/** The linked event's category first, else a pinned event's (an excluded one preferred), else null. */
export function toEligibilityRound(row: { subsession_id: number } & Partial<RoundEventEmbed>): EligibilityRound {
  const linked = row.event?.category;
  if (typeof linked === 'string') return { subsession_id: row.subsession_id, event_category: linked };
  // PostgREST returns a to-many embed as an array; anything else counts as no pinned events.
  const pinned = Array.isArray(row.pinned_events) ? row.pinned_events : [];
  const categories = pinned.map((e) => e?.category).filter((c): c is string => typeof c === 'string');
  const category = categories.find(isExcludedCategory) ?? categories[0] ?? null;
  return { subsession_id: row.subsession_id, event_category: category };
}
