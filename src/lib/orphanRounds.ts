/**
 * "Orphaned" rounds — curated_rounds rows the iRacing results pipeline
 * inserted but that aren't fully wired into the site yet:
 *
 *  - no season_id  → the round doesn't appear under ANY season on the Results
 *                    page, and recalculate_race_scores() refuses to score it
 *                    ("Round is not linked to a season"). The pipeline only
 *                    fills in the free-text `season_label` (e.g. "ATC18").
 *  - no event_id   → the round isn't tied to a calendar event, so the
 *                    incident-reporting window, event-based exhibition/test
 *                    flags and the event's "results" link have nothing to
 *                    attach to (see 0078_curated_rounds_event_id...).
 *
 * Admin > Events lists these (src/pages/admin/events/index.astro) with a
 * Season + Event picker; associateRound() below applies the choice and then
 * re-scores the round so it shows up with points straight away.
 */
import {
  restGet,
  restGetAll,
  restPatch,
  getEvents,
  getSeasons,
  type EventWithCircuit,
  type Season,
  type SupabaseEnv,
} from './supabase';
import { LEAGUE_TIME_ZONE } from './timezone';

export interface OrphanRound {
  subsession_id: number;
  start_time: string;
  track_name: string;
  layout: string | null;
  season_label: string | null;
  season_id: string | null;
  event_id: string | null;
  format: string | null;
  /** True when race_scores already has rows for this round. */
  scored: boolean;
  /** League-local calendar date (YYYY-MM-DD) of the round's start — what events.event_date is compared against. */
  localDate: string;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LEAGUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Every round missing a season or an event, newest first, flagged with whether it has been scored yet. */
export async function getOrphanedRounds(env: SupabaseEnv): Promise<OrphanRound[]> {
  const rounds = await restGetAll<Omit<OrphanRound, 'scored' | 'localDate'>>(
    env,
    'curated_rounds?select=subsession_id,start_time,track_name,layout,season_label,season_id,event_id,format&or=(season_id.is.null,event_id.is.null)&order=start_time.desc'
  );
  if (rounds.length === 0) return [];
  const ids = rounds.map((r) => r.subsession_id).join(',');
  const scoredRows = await restGetAll<{ subsession_id: number }>(env, `race_scores?select=subsession_id&subsession_id=in.(${ids})&race_number=eq.1`);
  const scored = new Set(scoredRows.map((r) => r.subsession_id));
  return rounds.map((r) => ({
    ...r,
    scored: scored.has(r.subsession_id),
    localDate: dayFormatter.format(new Date(r.start_time)),
  }));
}

/** Subsession ids of every round already tied to an event — those events can't be claimed again (curated_rounds_event_id_unique_idx). */
async function getClaimedEventIds(env: SupabaseEnv): Promise<Set<string>> {
  const rows = await restGet<{ event_id: string }[]>(env, 'curated_rounds?select=event_id&event_id=not.is.null');
  return new Set(rows.map((r) => r.event_id));
}

export interface OrphanPickerData {
  seasons: Season[];
  /** Events no round has claimed yet, newest first — the only ones a round can still be attached to. Holiday/iRacing events (no race) are left out. */
  availableEvents: EventWithCircuit[];
}

export async function getOrphanPickerData(env: SupabaseEnv): Promise<OrphanPickerData> {
  const [seasons, events, claimed] = await Promise.all([getSeasons(env), getEvents(env), getClaimedEventIds(env)]);
  const availableEvents = events
    .filter((e) => !claimed.has(e.id) && e.category !== 'holiday' && e.category !== 'iracing')
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  return { seasons, availableEvents };
}

/** The one unclaimed event on the same circuit and league-local date as this round, or null when there are none or several (never guesses between two). */
export function suggestEvent(round: OrphanRound, availableEvents: EventWithCircuit[]): EventWithCircuit | null {
  const matches = availableEvents.filter(
    (e) => e.event_date === round.localDate && (e.circuits?.name ?? '').toLowerCase() === round.track_name.toLowerCase()
  );
  return matches.length === 1 ? matches[0] : null;
}

export interface AssociateResult {
  /** Rows race_scores now holds for this round, or null when scoring wasn't attempted / failed. */
  rowsScored: number | null;
  /** Why scoring failed (no ruleset, standings locked, ...) — the association itself still went through. */
  scoreError: string | null;
}

/**
 * Applies a Season and/or Event choice to one round:
 *  - season_id (+ season_label) and event_id are set;
 *  - format / layout are filled in from the event when the round has none
 *    (scoring can't pick a points table without a format);
 *  - an Exhibition / Test event flags the round the same way imports do
 *    (round_overrides);
 *  - then recalculate_race_scores() runs so the round has points right away.
 * Throws on a bad choice or a failed write; a scoring failure is reported in
 * the result instead (the link is still saved).
 */
export async function associateRound(
  env: SupabaseEnv,
  accessToken: string,
  input: { subsessionId: number; seasonId: string | null; eventId: string | null }
): Promise<AssociateResult & { label: string }> {
  const { subsessionId } = input;
  const rounds = await restGet<{ subsession_id: number; track_name: string; format: string | null; layout: string | null; season_id: string | null }[]>(
    env,
    `curated_rounds?select=subsession_id,track_name,format,layout,season_id&subsession_id=eq.${subsessionId}`
  );
  const round = rounds[0];
  if (!round) throw new Error('That round no longer exists.');

  const events = input.eventId ? await restGet<EventWithCircuit[]>(env, `events?select=id,format,layout,category,season_id,round_number,event_date&id=eq.${encodeURIComponent(input.eventId)}`) : [];
  const event = events[0] ?? null;
  if (input.eventId && !event) throw new Error('That event no longer exists.');

  let seasonId = input.seasonId;
  if (event?.season_id) {
    if (seasonId && seasonId !== event.season_id) throw new Error("That event belongs to a different season than the one you picked.");
    seasonId = event.season_id;
  }
  if (!seasonId && !event) throw new Error('Pick a season, an event, or both.');
  const seasons = seasonId ? await restGet<Season[]>(env, `seasons?select=id,name&id=eq.${encodeURIComponent(seasonId)}`) : [];
  const season = seasons[0] ?? null;
  if (seasonId && !season) throw new Error('That season no longer exists.');

  const patch: Record<string, unknown> = {};
  if (season) {
    patch.season_id = season.id;
    patch.season_label = season.name;
  }
  if (event) {
    patch.event_id = event.id;
    if (!round.format && (event.format === 'sprint' || event.format === 'endurance')) patch.format = event.format;
    if (!round.layout && event.layout) patch.layout = event.layout;
  }
  await restPatch(env, accessToken, `curated_rounds?subsession_id=eq.${subsessionId}`, patch);

  if (event && (event.category === 'exhibition' || event.category === 'test')) {
    const flag = event.category === 'exhibition' ? { is_exhibition: true } : { is_test: true };
    const res = await fetch(`${env.url}/rest/v1/round_overrides?on_conflict=subsession_id`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify({ subsession_id: subsessionId, ...flag }),
    });
    if (!res.ok) throw new Error(`Couldn't flag the round as ${event.category}: ${await res.text()}`);
  }

  const label = `${round.track_name}${season ? ` → ${season.name}` : ''}`;
  if (!season && !round.season_id) return { rowsScored: null, scoreError: null, label };

  const res = await fetch(`${env.url}/rest/v1/rpc/recalculate_race_scores`, {
    method: 'POST',
    headers: { apikey: env.anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_subsession_id: subsessionId }),
  });
  if (!res.ok) {
    let message = await res.text();
    try {
      message = (JSON.parse(message) as { message?: string }).message ?? message;
    } catch {
      // keep raw text
    }
    return { rowsScored: null, scoreError: message, label };
  }
  const written = (await res.json()) as number;
  return { rowsScored: typeof written === 'number' ? written : null, scoreError: null, label };
}
