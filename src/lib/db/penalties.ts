import { restDelete, restGet, restGetAll, restPatch, restPost, type SupabaseEnv } from './client';

// ---------------------------------------------------------------------------
// PENALTIES (rulebook 18.3, section 5 "Stewarding") — see 0014_penalties.sql
// The database scores penalties (score_round, supabase/migrations/); the
// pages read the Penalty type below for display (src/lib/penalties/).
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
  /**
   * 'race' (default) | 'qualifying' | 'practice' (0056). Groups incidents by session on the Incident Report
   * page. A qualifying or practice penalty scores on race 1 (score_round in the database; scoringRaceNumber
   * in src/lib/penalties/effective.ts for display).
   */
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
   * Appeal fields (0016_penalty_appeals.sql). Once is_appealed is set, the appeal_* values replace the
   * originals wherever time/points/PP are read (src/lib/penalties/effective.ts); the originals stay as the
   * record. appeal_result is free-text, display only.
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
 * Every penalty in the given rounds, oldest first, for season standings and a driver's season PP/warning
 * tally (computeSeasonPPState/countWarnings in src/lib/penalties/penaltyPoints.ts). No query for an empty
 * list, since `in.()` isn't a filter.
 */
export async function getPenaltiesForSubsessions(
  env: SupabaseEnv,
  subsessionIds: number[],
): Promise<Penalty[]> {
  if (subsessionIds.length === 0) return [];
  // restGetAll: a whole-career query (computeDriverCareerStats) can pass Supabase's 1000-row cap.
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
 * Updates a penalty, then replaces its offense and driver links wholesale, the simplest correct handling of a
 * checkbox list. The caller recomputes the driver's season PP from scratch afterwards, so no stored counter
 * needs adjusting.
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
 * driver_id -> warning count within the given rounds; pass the current season's rounds
 * (getCurrentSeasonRounds in src/lib/results/seasonContext.ts), since warnings are season-scoped (Logan).
 * Shown while logging a new penalty.
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
