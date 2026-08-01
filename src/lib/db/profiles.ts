/**
 * Profile reads/writes. These used to live in lib/auth.ts, which meant that
 * file mixed two unrelated things: GoTrue token exchange (a different API,
 * different base path, different failure modes) and ordinary PostgREST rows.
 * `profiles` is just another table — it belongs here with the rest of them.
 * lib/auth.ts now only does tokens and cookies.
 */

import type { RestClient } from './client';
import type { Profile } from './types';

const SELECT = 'id,role,display_name,driver_id,iracing_cust_id,iracing_name';

export function profilesRepo(rest: RestClient) {
  return {
    /**
     * Returns null rather than throwing when the profile can't be read.
     * The middleware depends on this: a session whose profile lookup fails
     * should still resolve to a signed-in user with `profile: null` (and so
     * get bounced from /admin by the role check), not blow up the request.
     */
    async getById(userId: string): Promise<Profile | null> {
      try {
        const rows = await rest.get<Profile[]>(
          `profiles?id=eq.${encodeURIComponent(userId)}&select=${SELECT}`,
          { authed: true }
        );
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },

    /** Every profile, for the admin "assign roles" screen. Throws if RLS rejects it. */
    list() {
      return rest.get<Profile[]>(`profiles?select=${SELECT}&order=created_at.asc`, { authed: true });
    },

    setRole(profileId: string, role: Profile['role']) {
      return rest.patch<Profile>(`profiles?id=eq.${encodeURIComponent(profileId)}`, { role });
    },
  };
}
