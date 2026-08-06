/**
 * Shared server-side orchestration for the penalty admin forms — extracted
 * so both the round results page (src/pages/results/[subsessionId].astro)
 * and the Incident Report page (src/pages/results/[subsessionId]/
 * incidents.astro, where all penalty add/edit/remove now actually lives —
 * see v0.16's README section) read/write penalties the same way rather
 * than maintaining two copies of this logic.
 */

import {
  getDriverById,
  updateDriver,
  getEvents,
  getPenaltiesForSubsessions,
  type SupabaseEnv,
} from './supabase';
import { getCurrentSeasonRounds } from './results';
import { computeSeasonPPState } from './penalties';

/**
 * Recomputes one driver's CURRENT SEASON PP tally/probation state from
 * scratch (see computeSeasonPPState's own doc comment for why "from
 * scratch" beats incrementally patching a stored counter) and persists it.
 * Call after every penalty create/update/delete — not just creation like in
 * v0.13/v0.14 — so editing or removing a penalty correctly ripples through,
 * and so PP stays scoped to the CURRENT season (rule 57's season limit)
 * rather than accumulating across a driver's whole career. A no-op if no
 * season is currently flagged `is_current`.
 */
export async function recomputeDriverSeasonPP(env: SupabaseEnv, accessToken: string, driverId: string) {
  const [driver, currentSeason, events] = await Promise.all([
    getDriverById(env, driverId),
    getCurrentSeasonRounds(env),
    getEvents(env),
  ]);
  if (!driver || currentSeason.subsessionIds.length === 0) return;

  const seasonPenalties = await getPenaltiesForSubsessions(env, currentSeason.subsessionIds);
  const driverPenalties = seasonPenalties.filter((p) => p.driver_id === driverId);
  const state = computeSeasonPPState(driver, driverPenalties, events);

  await updateDriver(env, accessToken, driverId, {
    penalty_points: state.penalty_points,
    on_probation: state.on_probation,
    probation_started_at: state.probation_started_at,
  });
}

/** Blank-means-null/0 form field readers, shared by every penalty add/edit form. */
export function strOrNullField(form: FormData, name: string) {
  const s = String(form.get(name) ?? '').trim();
  return s.length > 0 ? s : null;
}
export function numOrNullField(form: FormData, name: string) {
  const s = String(form.get(name) ?? '').trim();
  return s.length > 0 ? Number(s) : null;
}
export function numOrZeroField(form: FormData, name: string) {
  const s = String(form.get(name) ?? '').trim();
  return s.length > 0 ? Number(s) : 0;
}
