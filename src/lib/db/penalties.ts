import { restDelete, restGet, restGetAll, restPatch, restPost, type SupabaseEnv } from './client';

// ---------------------------------------------------------------------------
// PENALTIES (rulebook 18.3, section 5 "Stewarding") — see 0014_penalties.sql
// and src/lib/penalties.ts (the position/points recalculation engine, which
// consumes the Penalty type below).
// ---------------------------------------------------------------------------

export interface PenaltyOffense {
  id: string;
  name: string;
  /** Free text (e.g. "1-4", "Warning or 1") — see 0014_penalties.sql for why this isn't a plain number. Reference only; never auto-summed into a penalty's actual penalty_points. */
  reference_points: string | null;
  sort_order: number;
}

const PENALTY_OFFENSE_SELECT = 'id,name,reference_points,sort_order';

export function getPenaltyOffenses(env: SupabaseEnv) {
  return restGet<PenaltyOffense[]>(
    env,
    `penalty_offenses?select=${PENALTY_OFFENSE_SELECT}&order=sort_order.asc`,
  );
}

export function createPenaltyOffense(env: SupabaseEnv, accessToken: string, data: Partial<PenaltyOffense>) {
  return restPost<PenaltyOffense>(env, accessToken, 'penalty_offenses', data);
}

export function updatePenaltyOffense(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<PenaltyOffense>,
) {
  return restPatch<PenaltyOffense>(
    env,
    accessToken,
    `penalty_offenses?id=eq.${encodeURIComponent(id)}`,
    data,
  );
}

export function deletePenaltyOffense(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `penalty_offenses?id=eq.${encodeURIComponent(id)}`);
}

export interface Penalty {
  id: string;
  subsession_id: number;
  /** For session_type 'qualifying'/'practice' this is always the sentinel 0 — quali/practice aren't split by race, and race_number = 0 can never collide with a real race (curated_race_results.race_number is always 1-5). See session_type below and 0056_penalty_session_type.sql. */
  race_number: number;
  /** 'race' (default) | 'qualifying' | 'practice' (0056_penalty_session_type.sql). Purely a display/grouping concern — the Incident Report page groups by this field instead of race_number alone so Qualifying/Practice get their own sections. For SCORING, a qualifying/practice incident's own penalty (offenses, PP, time, points) always applies to Race 1, same as if it had been logged directly against it — see scoringRaceNumber in src/lib/penalties.ts, which every recalculation pass keys off instead of the raw race_number. */
  session_type: 'race' | 'qualifying' | 'practice';
  /** Null means "Racing Incident" — reviewed and judged nobody's fault, so no driver is attached (0020_penalty_racing_incident.sql). Shown as "RI" in the Incident Report's Driver column instead of a car number, and never affects anyone's position/points — the recalculation engine keys everything off driver_id, so a row with none can't touch any driver's result. */
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  /** Flags this as (also, or only) a warning — rulebook offense "2 warnings" escalates to +1 PP, so stewards need to see how many a driver already has (see getWarningCounts) before logging a third. Doesn't change how the penalty's own time/points/PP fields are applied — a warning can still carry a real PP value if the steward enters one. */
  is_warning: boolean;
  created_at: string;
  /** Every offense tagged on this penalty — descriptive/record-keeping only, doesn't drive any of the math (see penalty_points above). */
  offense_ids: string[];
  /** Other drivers' cars that were part of the same incident — descriptive only, same as offense_ids. */
  involved_driver_ids: string[];
  /**
   * Appeal fields (0016_penalty_appeals.sql). Once is_appealed is set, every
   * place src/lib/penalties.ts reads this penalty's time/points/PP uses the
   * appeal_* values instead of the original ones (see its effective* helpers)
   * — the original fields stay put as a record of what was first logged.
   * appeal_result is a free-text ruling ("Upheld", "Reduced to 5s", etc.),
   * shown alongside the penalty but not itself consumed by any calculation.
   */
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

export interface PenaltyRow {
  id: string;
  subsession_id: number;
  race_number: number;
  session_type: 'race' | 'qualifying' | 'practice';
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_warning: boolean;
  created_at: string;
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
  penalty_offense_links: { offense_id: string }[];
  penalty_involved_drivers: { driver_id: string }[];
}

const PENALTY_SELECT =
  'id,subsession_id,race_number,session_type,driver_id,incident_number,lap,description,' +
  'time_penalty_seconds,points_penalty,penalty_points,is_warning,created_at,' +
  'is_appealed,appeal_result,appeal_time_penalty_seconds,appeal_points_penalty,appeal_penalty_points,' +
  'penalty_offense_links(offense_id),penalty_involved_drivers(driver_id)';

export function toPenalty(row: PenaltyRow): Penalty {
  const { penalty_offense_links, penalty_involved_drivers, ...rest } = row;
  return {
    ...rest,
    offense_ids: penalty_offense_links.map((l) => l.offense_id),
    involved_driver_ids: penalty_involved_drivers.map((l) => l.driver_id),
  };
}

/** Every penalty logged against any race in one round, oldest first (so later penalties, if any ever stack for the same driver+race, apply in the order they were issued). */
export async function getPenaltiesForSubsession(env: SupabaseEnv, subsessionId: number): Promise<Penalty[]> {
  const rows = await restGet<PenaltyRow[]>(
    env,
    `penalties?select=${encodeURIComponent(PENALTY_SELECT)}&subsession_id=eq.${subsessionId}&order=created_at.asc`,
  );
  return rows.map(toPenalty);
}

/**
 * Every penalty logged against any of the given rounds, oldest first — the
 * bulk version of getPenaltiesForSubsession, used wherever a whole season
 * (not just one round) needs to be recalculated: season standings
 * (src/lib/results.ts) and a driver's season-scoped PP/warning tally (see
 * computeSeasonPPState/countWarnings in src/lib/penalties.ts). Returns an
 * empty list (no query) for an empty input, since PostgREST's `in.()` with
 * nothing inside it isn't a meaningful filter.
 */
export async function getPenaltiesForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<Penalty[]> {
  if (subsessionIds.length === 0) return [];
  // restGetAll (not restGet) — a whole-career query (src/lib/results.ts's
  // computeDriverCareerStats) can span hundreds of rounds across every
  // season at once, and a plain restGet would silently truncate at
  // Supabase's default 1000-row response cap instead of erroring. See
  // restGetAll's own doc comment.
  const rows = await restGetAll<PenaltyRow>(
    env,
    `penalties?select=${encodeURIComponent(PENALTY_SELECT)}&subsession_id=in.(${subsessionIds.join(',')})&order=created_at.asc`,
  );
  return rows.map(toPenalty);
}

export interface PenaltyInput {
  subsession_id: number;
  race_number: number;
  session_type: 'race' | 'qualifying' | 'practice';
  /** Null for a Racing Incident (no driver at fault) — see Penalty.driver_id's own doc comment. */
  driver_id: string | null;
  incident_number: string | null;
  lap: number | null;
  description: string | null;
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_warning: boolean;
  is_appealed: boolean;
  appeal_result: string | null;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

/** Inserts a penalty and links it to every selected offense/involved driver — three REST calls, not a real transaction (this backend is plain PostgREST, no server-side function for this yet), so a failure partway through can in principle leave a penalty with no tags/involved cars linked. Acceptable for now: the penalty's own time/points/PP fields (the numbers that actually drive recalculation) are set atomically on the first insert either way. */
export async function createPenalty(
  env: SupabaseEnv,
  accessToken: string,
  data: PenaltyInput,
  offenseIds: string[],
  involvedDriverIds: string[],
): Promise<Penalty> {
  const created = await restPost<PenaltyRow>(env, accessToken, 'penalties', data);
  if (offenseIds.length > 0) {
    await restPost(
      env,
      accessToken,
      'penalty_offense_links',
      offenseIds.map((offense_id) => ({ penalty_id: created.id, offense_id })),
    );
  }
  if (involvedDriverIds.length > 0) {
    await restPost(
      env,
      accessToken,
      'penalty_involved_drivers',
      involvedDriverIds.map((driver_id) => ({ penalty_id: created.id, driver_id })),
    );
  }
  return { ...created, offense_ids: offenseIds, involved_driver_ids: involvedDriverIds };
}

/**
 * Updates a penalty's own fields, then replaces its offense/involved-driver
 * links wholesale (delete everything currently linked, insert the new
 * selection) rather than trying to diff them — simplest correct way to
 * handle a checkbox list that can add and remove entries in the same edit.
 * Unlike in v0.13/v0.14, editing a penalty's PP (or its own is_appealed
 * override) DOES now ripple through to the driver's season PP tally — the
 * caller (src/pages/results/[subsessionId].astro) re-runs
 * computeSeasonPPState over the driver's whole season after every mutation
 * rather than incrementally patching a stored counter, so there's no
 * separate "retroactive adjustment" step needed here.
 */
export async function updatePenalty(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<PenaltyInput>,
  offenseIds: string[],
  involvedDriverIds: string[],
): Promise<void> {
  await restPatch<PenaltyRow>(env, accessToken, `penalties?id=eq.${encodeURIComponent(id)}`, data);
  await restDelete(env, accessToken, `penalty_offense_links?penalty_id=eq.${encodeURIComponent(id)}`);
  await restDelete(env, accessToken, `penalty_involved_drivers?penalty_id=eq.${encodeURIComponent(id)}`);
  if (offenseIds.length > 0) {
    await restPost(
      env,
      accessToken,
      'penalty_offense_links',
      offenseIds.map((offense_id) => ({ penalty_id: id, offense_id })),
    );
  }
  if (involvedDriverIds.length > 0) {
    await restPost(
      env,
      accessToken,
      'penalty_involved_drivers',
      involvedDriverIds.map((driver_id) => ({ penalty_id: id, driver_id })),
    );
  }
}

/** Removes a penalty (its offense/involved-driver links cascade). Same as updatePenalty (see its doc comment): the caller re-recomputes the driver's season PP tally from scratch afterward, so a deleted penalty's PP correctly stops counting without any manual correction. */
export function deletePenalty(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `penalties?id=eq.${encodeURIComponent(id)}`);
}

/**
 * driver_id -> how many warnings (is_warning penalties) they have, scoped to
 * whichever subsession IDs the caller passes in — pass the current season's
 * round subsession_ids (see getCurrentSeasonRounds in src/lib/results.ts) to
 * get a season-scoped count, per Logan: "Warnings should be season-scoped,
 * not career-scoped." Used to surface "this driver has already been warned
 * N times this season" while logging a new penalty.
 */
export async function getWarningCounts(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subsessionIds.length === 0) return out;
  const rows = await restGet<{ driver_id: string | null }[]>(
    env,
    `penalties?select=driver_id&is_warning=eq.true&subsession_id=in.(${subsessionIds.join(',')})`,
  );
  // A Racing Incident (driver_id null) is never a warning in practice — the
  // add/edit dialog hides that checkbox once "Racing Incident" is selected
  // — but guard anyway rather than let a null slip into the map's keys.
  for (const r of rows) {
    if (!r.driver_id) continue;
    out.set(r.driver_id, (out.get(r.driver_id) ?? 0) + 1);
  }
  return out;
}
