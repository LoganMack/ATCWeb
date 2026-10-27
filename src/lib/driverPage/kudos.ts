/**
 * The driver profile's kudos button and dialog (driver-profile-polish FR6): every kudos the driver is one of
 * the cars involved in, newest first, with each round's label. Read as its own fragment so the profile's
 * cached shell gains no read (FR6.5). The driver check comes first, so an unknown id or a private profile
 * reads no kudos.
 */
import type { SupabaseEnv } from '../db/client';
import { getKudosInvolvingDriver, type KudosEntry } from '../kudos';
import { getRoundContexts, type RoundContext } from '../roundContext';
import { findProfileDriver } from './load';

export interface DriverKudos {
  notFound: boolean;
  privateProfile: boolean;
  loadError: boolean;
  entries: KudosEntry[];
  rounds: Map<number, RoundContext>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadDriverKudos(env: SupabaseEnv, driverId: string): Promise<DriverKudos> {
  const empty = { entries: [] as KudosEntry[], rounds: new Map<number, RoundContext>() };
  if (!UUID.test(driverId)) return { notFound: true, privateProfile: false, loadError: false, ...empty };
  try {
    const driver = await findProfileDriver(env, driverId);
    if (!driver) return { notFound: true, privateProfile: false, loadError: false, ...empty };
    if (driver.profile_private) return { notFound: false, privateProfile: true, loadError: false, ...empty };
    const [kudos, rounds] = await Promise.all([
      getKudosInvolvingDriver(env, driverId),
      getRoundContexts(env),
    ]);
    // A kudos whose round is not listed (hidden by "View as Broadcaster") is left out of the count and list.
    const entries = kudos.filter((k) => rounds.has(k.subsession_id));
    return { notFound: false, privateProfile: false, loadError: false, entries, rounds };
  } catch (err) {
    // The status only: an error's text may echo the request.
    const status = err instanceof Error ? Number(/\berror (\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
    console.error('driver kudos load failed', status);
    return { notFound: false, privateProfile: false, loadError: true, ...empty };
  }
}
