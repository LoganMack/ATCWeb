/**
 * Builds the data-access layer for one request.
 *
 * `src/middleware.ts` calls this once per on-demand request and hangs the
 * result off `Astro.locals.db`, so pages just do:
 *
 *     const drivers = await Astro.locals.db.drivers.list();
 *
 * instead of the old `resolveSupabaseEnv(Astro.locals)` +
 * `Astro.locals.session!.accessToken` + pass-both-into-every-call dance that
 * was repeated across 16 files. The env and the caller's token are bound in
 * here once; nothing downstream has to know they exist.
 */

import type { SiteEnv } from '../env';
import { createRest } from './client';
import { driversRepo } from './drivers';
import { teamsRepo } from './teams';
import { newsRepo } from './news';
import { profilesRepo } from './profiles';
import { lookupsRepo } from './lookups';
import { storageRepo } from './storage';

export function createDb(env: SiteEnv, accessToken: string | null) {
  const rest = createRest(env, accessToken);
  return {
    rest,
    drivers: driversRepo(rest),
    teams: teamsRepo(rest),
    news: newsRepo(rest),
    profiles: profilesRepo(rest),
    lookups: lookupsRepo(rest),
    storage: storageRepo(rest),
  };
}

export type Db = ReturnType<typeof createDb>;

export { SupabaseError } from './client';
export { extFromFile } from './storage';
export type {
  Driver,
  DriverRecord,
  Lookup,
  NewsPost,
  NewsPostAdmin,
  Profile,
  StorageBucket,
  Team,
} from './types';
