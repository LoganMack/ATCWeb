/**
 * Server-side penalty form handling shared by the round results page and the Incident Report page, so both
 * read and write penalties the same way.
 */

import { getDriverById, updateDriver } from './db/drivers';
import { getEvents } from './db/events';
import { getPenaltiesForSubsessions } from './db/penalties';
import { withAccessToken, type SupabaseEnv } from './db/client';
import { getCurrentSeasonRounds } from './results/seasonContext';
import { computeSeasonPPState } from './penalties/penaltyPoints';

/**
 * Recomputes and saves one driver's current-season PP and probation from scratch (computeSeasonPPState). Call
 * after every penalty create, update or delete. No-op when no season is current.
 */
export async function recomputeDriverSeasonPP(env: SupabaseEnv, accessToken: string, driverId: string) {
  const [driver, currentSeason, events] = await Promise.all([
    // The base drivers row, read as the admin (U4 BR9.13).
    getDriverById(withAccessToken(env, accessToken), driverId),
    getCurrentSeasonRounds(env),
    getEvents(env),
  ]);
  if (!driver || currentSeason.subsessionIds.length === 0) return;

  // Read as the admin: penalties of rounds not yet posted are hidden from the anon key (0112) but still count.
  const seasonPenalties = await getPenaltiesForSubsessions(
    withAccessToken(env, accessToken),
    currentSeason.subsessionIds,
  );
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
