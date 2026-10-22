import { uploadToStorage } from './assets';
import { formatDate } from './circuits';
import { restDelete, restGet, restPatch, restPost, writeHeaders, type SupabaseEnv } from './client';

// --- Drivers (admin — raw FK columns, not the embedded/joined shape) -------

export interface DriverRecord {
  id: string;
  car_number: number | null;
  name: string;
  status_id: number;
  class_id: number;
  team_id: string | null;
  /**
   * Their iRacing customer id — the ONLY thing that links this drivers row
   * to their actual race results (curated_race_results.cust_id,
   * recalculate_race_scores()'s entrant join, driver_last_race — see those
   * for the full list). Added to `drivers` outside this repo's migrations
   * (see 0005_round_overrides.sql's grant-fix note), and until now had no
   * admin UI field at all despite raceResultsImport.ts's own doc comment
   * telling admins to "set it first on their Roster profile" — the Sync
   * Results with Roster button (src/lib/raceResultsImport.ts's
   * syncResultsWithRoster) is what actually needs this field editable, so
   * a driver it links (rather than creates fresh) can be corrected by hand
   * afterward, and so an admin can fix a genuine mismatch without a direct
   * database edit.
   */
  iracing_cust_id: number | null;
  is_rookie: boolean;
  car: string | null;
  appearances: number;
  starts: number;
  seasons_count: number;
  penalty_points: number;
  penalty_points_max: number;
  photo_url: string | null;
  bio: string | null;
  sign_up_date: string | null; // 'YYYY-MM-DD'
  on_probation: boolean;
  probation_started_at: string | null; // 'YYYY-MM-DD'
  /** 0027_hall_of_fame.sql — toggled by an admin, powers the public /hall-of-fame page. See getHallOfFameDrivers(). */
  is_hall_of_fame: boolean;
  /** 0057_driver_ai_flag.sql — marks this row as an AI-controlled entrant that exists only to satisfy an exhibition result's FK. Excluded by default everywhere (getDrivers/driversSelect) except getRoundResults()/getQualifyingForSubsession() and the admin Drivers list's "AI" filter tab. See src/lib/results.ts's driversSelect() for the full reasoning. */
  is_ai: boolean;
  /** ISO 3166-1 alpha-2 codes (lowercase), 0029_driver_nationality.sql — see src/components/DriverFlag.astro. */
  nationality_1: string | null;
  nationality_2: string | null;
  /** iRating when this driver joined ATC — reference only, not validated against iRacing's real range. 0039_driver_admin_overhaul.sql. */
  starting_irating: number | null;
  created_at: string;
  updated_at: string;
  /** auth.users.id of whoever created/most-recently-touched this row — auto-stamped by the drivers_set_audit_fields trigger, never sent by the app. 0039_driver_admin_overhaul.sql. */
  created_by: string | null;
  updated_by: string | null;
}

const DRIVER_ADMIN_SELECT =
  'id,car_number,name,status_id,class_id,team_id,iracing_cust_id,is_rookie,car,appearances,starts,' +
  'seasons_count,penalty_points,penalty_points_max,photo_url,bio,sign_up_date,on_probation,probation_started_at,is_hall_of_fame,is_ai,' +
  'nationality_1,nationality_2,starting_irating,created_at,updated_at,created_by,updated_by';

export async function getDriverById(env: SupabaseEnv, id: string) {
  const drivers = await restGet<DriverRecord[]>(
    env,
    `drivers?select=${DRIVER_ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return drivers[0] ?? null;
}

export function createDriver(env: SupabaseEnv, accessToken: string, data: Partial<DriverRecord>) {
  return restPost<DriverRecord>(env, accessToken, 'drivers', data);
}

export function updateDriver(env: SupabaseEnv, accessToken: string, id: string, data: Partial<DriverRecord>) {
  return restPatch<DriverRecord>(env, accessToken, `drivers?id=eq.${encodeURIComponent(id)}`, data);
}

/** Lean lookup for the admin driver edit page's live "is this number taken?" check — every driver with a car_number set, plus enough to explain who holds it. Fetched once and matched client-side as the admin types, rather than a round trip per keystroke. */
export interface DriverNumberLookup {
  id: string;
  name: string;
  car_number: number;
  driver_statuses: { name: string } | null;
}

export function getDriversForNumberCheck(env: SupabaseEnv) {
  return restGet<DriverNumberLookup[]>(
    env,
    'drivers?select=id,name,car_number,driver_statuses(name)&car_number=not.is.null',
  );
}

/** Every driver who already has an iRacing Customer ID set — used both by the admin driver edit page's "is this cust_id already claimed by someone else?" check (see readForm/the save handler in admin/drivers/[id].astro) and by raceResultsImport.ts's syncResultsWithRoster, which must never link a cust_id to more than one drivers row (recalculate_race_scores() joins on this column — a duplicate would double-count that one raw result). */
export interface DriverCustIdLookup {
  id: string;
  name: string;
  iracing_cust_id: number | null;
}

export function getDriversForCustIdCheck(env: SupabaseEnv) {
  return restGet<DriverCustIdLookup[]>(
    env,
    'drivers?select=id,name,iracing_cust_id&iracing_cust_id=not.is.null',
  );
}

/** Every driver's most recent race, plus how many official league rounds have run since then (league-wide, not season/class-scoped) — see driver_last_race (0039_driver_admin_overhaul.sql, revised by 0040_inactivity_90d_or_12_rounds.sql). rounds_since_last_race is null exactly when last_race_at is null (never raced / no iracing_cust_id). Powers both sync_driver_statuses() and the admin edit page's inactivity note — a driver goes Inactive once BOTH the configured inactivity-days and inactivity-rounds thresholds have passed since last_race_at (whichever takes longer — see 0041_driver_settings.sql). */
export interface DriverLastRace {
  last_race_at: string | null;
  rounds_since_last_race: number | null;
}

export async function getDriverLastRace(env: SupabaseEnv, driverId: string): Promise<DriverLastRace> {
  const rows = await restGet<DriverLastRace[]>(
    env,
    `driver_last_race?select=last_race_at,rounds_since_last_race&driver_id=eq.${encodeURIComponent(driverId)}`,
  );
  return rows[0] ?? { last_race_at: null, rounds_since_last_race: null };
}

/** Bulk form of getDriverLastRace — one unfiltered query against the same driver_last_race view, for pages that need every driver's row at once (the admin Drivers list's status tooltip) rather than one REST call per driver. */
export interface DriverLastRaceRow extends DriverLastRace {
  driver_id: string;
}

export function getAllDriverLastRaces(env: SupabaseEnv): Promise<DriverLastRaceRow[]> {
  return restGet<DriverLastRaceRow[]>(
    env,
    'driver_last_race?select=driver_id,last_race_at,rounds_since_last_race',
  );
}

/**
 * Number of officially-scored rounds (curated_rounds, via
 * getOfficialRoundStartTimes() in results.ts) strictly after `sinceDate` —
 * matches sync_driver_statuses()'s own never-raced-driver Inactive check
 * (0063_driver_never_raced_inactivity.sql: `curated_rounds.status =
 * 'official' and start_time > sign_up_date`) exactly, so buildInactivityNote()
 * shows a New driver's real progress toward the inactivity-rounds threshold
 * — the same rounds count the database itself uses to decide when to flip
 * them, not an approximation.
 *
 * Deliberately NOT calendar events, despite isOnProbationNow() (src/lib/
 * penalties.ts) using exactly that "events since X" shape for its own
 * "rounds since a driver's own anchor date" clock — an earlier version of
 * this function reused that same events-based approach, which overcounts
 * (a scheduled-but-not-yet-run event, a cancelled round, or a
 * holiday/iracing placeholder entry all count as a calendar "event" but
 * aren't a real scored round). That mismatch let this tooltip claim a
 * driver had "fulfilled the requirements" to go Inactive — showing e.g.
 * 12/12 rounds absent — while the database's own rule, counting only real
 * curated_rounds, still saw 11 and correctly left them New. Comparison is
 * against midnight UTC on `sinceDate`, matching how Postgres compares a
 * `date` column against curated_rounds.start_time's `timestamptz`.
 */
export function roundsSinceDate(rounds: { start_time: string }[], sinceDate: string): number {
  const sinceMidnightUtc = new Date(`${sinceDate}T00:00:00Z`).getTime();
  return rounds.filter((r) => new Date(r.start_time).getTime() > sinceMidnightUtc).length;
}

/**
 * The same inactivity-countdown message shown on the admin driver edit page
 * (next to the Status pill) — pulled out here so the admin Drivers LIST page
 * can reuse it verbatim as a hover tooltip instead of re-deriving its own
 * copy that could drift out of sync. Always returns a message for any
 * recognized status (New/Active/Veteran/Inactive); null only for an
 * unrecognized/missing status name (e.g. a brand new driver with no status
 * yet), same as the edit page's own "only meaningful once the driver
 * actually exists" guard.
 *
 * signUpDate/roundsSinceSignup are only consulted for the New/Active-with-
 * no-races-yet case below — every caller that can supply them should (see
 * roundsSinceDate above for how to compute the latter); a caller that
 * doesn't (or a driver with no sign_up_date on file) just falls back to the
 * generic threshold description instead of a real progress breakdown.
 */
export function buildInactivityNote(
  statusName: string | null,
  lastRace: DriverLastRace | null | undefined,
  inactivityDays: number,
  inactivityRounds: number,
  signUpDate?: string | null,
  roundsSinceSignup?: number | null,
): string | null {
  if (statusName === 'Veteran') return 'Veterans are exempt from inactivity.';
  if (statusName === 'Inactive') return 'Inactive until next appearance.';
  if (statusName === 'New' || statusName === 'Active') {
    if (!lastRace?.last_race_at) {
      if (!signUpDate) {
        return `Inactive if absent ${inactivityDays} days and ${inactivityRounds} rounds after sign-up.`;
      }
      const signUpStart = new Date(`${signUpDate}T00:00:00`);
      const daysSinceSignup = Math.floor((Date.now() - signUpStart.getTime()) / (1000 * 60 * 60 * 24));
      const rounds = roundsSinceSignup ?? 0;
      return `Signed-up on ${formatDate(signUpDate)}; ${rounds}/${inactivityRounds} rounds absent; ${daysSinceSignup}/${inactivityDays} days absent`;
    }
    const daysSince = Math.floor(
      (Date.now() - new Date(lastRace.last_race_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const rounds = lastRace.rounds_since_last_race ?? 0;
    return `Last raced ${formatDate(lastRace.last_race_at)}; ${rounds}/${inactivityRounds} rounds absent; ${daysSince}/${inactivityDays} days absent`;
  }
  return null;
}

/**
 * The ONLY path for changing a driver's car_number — enforces Logan's rule
 * (block if held by anyone not Inactive; silently free it up if the holder
 * IS Inactive) inside one DB transaction via set_driver_car_number()
 * (0039_driver_admin_overhaul.sql), so the two writes involved (freeing the
 * old holder, assigning the new one) can never leave two drivers sharing a
 * number even momentarily. Throws with a message fit to show directly to
 * the admin (e.g. "Car #7 is already in use by Jane Doe (Active)") when the
 * number is taken by anyone not Inactive.
 */
export async function setDriverCarNumber(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
  carNumber: number | null,
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/set_driver_car_number`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify({ p_driver_id: driverId, p_car_number: carNumber }),
  });
  if (!res.ok) throw new Error(await res.text());
}

/**
 * Re-derives every driver's status from race activity — see
 * sync_driver_statuses() (0039_driver_admin_overhaul.sql, threshold made
 * dual day/round by 0040_inactivity_90d_or_12_rounds.sql, both thresholds
 * made admin-configurable via site_settings by 0041_driver_settings.sql)
 * for the exact rule (New/Active -> Inactive once BOTH the configured
 * inactivity-days and inactivity-rounds have passed since their last race;
 * Inactive -> Active on return; Veteran untouched). Status editing was
 * removed from the admin driver form entirely per Logan ("that should all
 * be automatic") — this is what keeps status current instead, called
 * opportunistically whenever an admin loads the Drivers pages (this app has
 * no cron/scheduled-worker infrastructure to run it on a real timer).
 * Returns how many rows changed.
 */
export async function syncDriverStatuses(env: SupabaseEnv, accessToken: string): Promise<number> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_driver_statuses`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as number;
}

/**
 * Re-derives is_rookie from career history — see sync_rookie_status()
 * (0041_driver_settings.sql). Once a driver reaches 3+ appearances in a
 * single season, they lose rookie status for good (this only ever flips
 * true -> false, never back). Rookie status is no longer admin-editable —
 * every new driver starts as a rookie (see createDriver's is_rookie: true
 * caller in the admin form) and this is what turns it off automatically.
 * Same opportunistic-call pattern as syncDriverStatuses. Returns how many
 * rows changed.
 */
export async function syncRookieStatus(env: SupabaseEnv, accessToken: string): Promise<number> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_rookie_status`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as number;
}

export interface SyncResultsWithRosterOutcome {
  /** Newly created drivers rows — see sync_results_with_roster() for the full rule. */
  created: string[];
  /** Existing drivers rows that just had their iracing_cust_id filled in. */
  linked: string[];
  /**
   * How many rounds the function recalculated in the legacy race_scores
   * table for the drivers linked or created above — every round their
   * cust_id already had raw results in. The results the site shows
   * (race_score_results) are rescored for those same rounds by the drivers
   * triggers in the same transaction (BR3.1), so this count still says
   * which rounds were refreshed.
   */
  roundsRecalculated: number;
  /** `"<subsession_id>: <error>"` for any round the legacy recalculation raised on (no ruleset yet, standings locked, etc.) — surfaced so it doesn't fail silently, not auto-retried. */
  recalcFailed: string[];
}

/**
 * Admin > Drivers "Sync Results with Roster" button. Every cust_id that
 * raced in a real (non-exhibition) round but has no matching drivers row —
 * see results.ts's RaceResultRow.notInRoster for the front-end symptom this
 * fixes — either gets linked onto an existing same-named driver with no
 * cust_id yet, or gets a new minimal drivers row created for it. Linking or
 * creating the driver fires the drivers scoring triggers, which rescore
 * every round that cust_id already has raw results in (BR3.1); otherwise
 * those rounds would stay invisible on the results page with no "not in
 * roster" tag to explain why (the bug Jordyn Propst surfaced). No separate
 * rescore_season call is needed: the function does not say which seasons
 * it touched, and the triggers already cover exactly those rounds.
 *
 * Deliberately a single RPC call (same opportunistic-automation pattern as
 * syncDriverStatuses/syncRookieStatus above) rather than doing the lookup
 * and per-driver creates/updates from the Worker: an earlier version did
 * exactly that and could burn through dozens to hundreds of subrequests in
 * one click (paging through all of curated_race_results, then one REST call
 * per driver touched) — exactly what tripped Cloudflare's per-invocation
 * subrequest limit in production. See sync_results_with_roster()
 * (0047_sync_results_with_roster.sql) for the actual logic — it also
 * excludes exhibition rounds/seasons (Logan: "sometimes those include AI
 * drivers"), which the original version never did.
 */
export async function syncResultsWithRoster(
  env: SupabaseEnv,
  accessToken: string,
): Promise<SyncResultsWithRosterOutcome> {
  const res = await fetch(`${env.url}/rest/v1/rpc/sync_results_with_roster`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as SyncResultsWithRosterOutcome;
}

export function deleteDriver(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `drivers?id=eq.${encodeURIComponent(id)}`);
}

// --- Driver season classes (per-season class override, see 0037_class_and_scoring_fixes.sql) -

export interface DriverSeasonClass {
  driver_id: string;
  season_id: string;
  class_id: number;
}

const DRIVER_SEASON_CLASS_SELECT = 'driver_id,season_id,class_id';

/** One driver's per-season class overrides — powers the "Driver Class by Season" list on the admin driver edit page. A season with no row here falls back to the driver's primary class (drivers.class_id) — same fallback scoring itself uses (see recalculate_race_scores in 0037_class_and_scoring_fixes.sql). */
export function getDriverSeasonClassesForDriver(env: SupabaseEnv, driverId: string) {
  return restGet<DriverSeasonClass[]>(
    env,
    `driver_season_classes?select=${DRIVER_SEASON_CLASS_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}`,
  );
}

/** Upserts a driver's class for one season — replaces whatever was set for that season before. The table's primary key is (driver_id, season_id), so this can never leave a driver with two classes in the same season. */
export async function upsertDriverSeasonClass(
  env: SupabaseEnv,
  accessToken: string,
  data: DriverSeasonClass,
) {
  const res = await fetch(`${env.url}/rest/v1/driver_season_classes?on_conflict=driver_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(`Supabase upsert error ${res.status} on driver_season_classes: ${await res.text()}`);
  const rows = (await res.json()) as DriverSeasonClass[];
  return rows[0];
}

/** Clears a driver's class override for one season — they fall back to their primary class for that season again. */
export function deleteDriverSeasonClass(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
  seasonId: string,
) {
  return restDelete(
    env,
    accessToken,
    `driver_season_classes?driver_id=eq.${encodeURIComponent(driverId)}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

// --- Driver season car numbers (per-season number override, see 0044_driver_season_car_numbers.sql) -

export interface DriverSeasonCarNumber {
  driver_id: string;
  season_id: string;
  car_number: number;
}

const DRIVER_SEASON_CAR_NUMBER_SELECT = 'driver_id,season_id,car_number';

/** One driver's per-season car number overrides — powers the "Driver Number by Season" list on the admin driver edit page. A season with no row here falls back to the driver's current number (drivers.car_number). */
export function getDriverSeasonCarNumbersForDriver(env: SupabaseEnv, driverId: string) {
  return restGet<DriverSeasonCarNumber[]>(
    env,
    `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}&driver_id=eq.${encodeURIComponent(driverId)}`,
  );
}

/** Every driver's number override for one season — used by the admin edit page to validate a new number isn't already claimed by someone else that season. */
export function getDriverSeasonCarNumbersForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<DriverSeasonCarNumber[]>(
    env,
    `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

/** Every driver_season_car_numbers row, across every season — the manual Race Results and Incident Report CSV importers fetch this once (rather than per-round-season) to resolve a CSV row's car number to a driver_id for that round's own season, before falling back to drivers.car_number. */
export function getAllDriverSeasonCarNumbers(env: SupabaseEnv) {
  return restGet<DriverSeasonCarNumber[]>(
    env,
    `driver_season_car_numbers?select=${DRIVER_SEASON_CAR_NUMBER_SELECT}`,
  );
}

/** Upserts a driver's car number for one season — replaces whatever was set for that season before. The table's primary key is (driver_id, season_id); its (season_id, car_number) unique constraint is the hard backstop against two drivers sharing a number in the same season (see 0044_driver_season_car_numbers.sql) — callers should validate that themselves first for a friendly error message, since this will otherwise throw a raw constraint-violation error. */
export async function upsertDriverSeasonCarNumber(
  env: SupabaseEnv,
  accessToken: string,
  data: DriverSeasonCarNumber,
) {
  const res = await fetch(`${env.url}/rest/v1/driver_season_car_numbers?on_conflict=driver_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(`Supabase upsert error ${res.status} on driver_season_car_numbers: ${await res.text()}`);
  const rows = (await res.json()) as DriverSeasonCarNumber[];
  return rows[0];
}

/** Clears a driver's car number override for one season — they fall back to their current number (drivers.car_number) for that season again. */
export function deleteDriverSeasonCarNumber(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
  seasonId: string,
) {
  return restDelete(
    env,
    accessToken,
    `driver_season_car_numbers?driver_id=eq.${encodeURIComponent(driverId)}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

export interface DriverOption {
  id: string;
  name: string;
  car_number: number | null;
}

/** Lean id/name/number list for admin dropdowns (e.g. picking a driver to add to a team's season roster). */
export function getDriversBasic(env: SupabaseEnv) {
  return restGet<DriverOption[]>(env, 'drivers?select=id,name,car_number&order=name.asc');
}

export interface HallOfFameDriverInfo {
  id: string;
  bio: string | null;
}

/**
 * Ids (+ bio, the one extra field the public Hall of Fame page needs that
 * career-stats' own `DriverBasic` doesn't already carry) of every driver an
 * admin has marked as a Hall of Fame member (0027_hall_of_fame.sql). The
 * page itself gets everything else — name, photo, career totals,
 * season-by-season breakdown — from `computeDriverCareerStats` in
 * src/lib/results.ts and just filters that down to these ids, so a
 * driver's HOF card always reflects the exact same numbers their Driver
 * Stats row would.
 */
export function getHallOfFameDrivers(env: SupabaseEnv) {
  // &is_ai=eq.false is belt-and-suspenders (0057_driver_ai_flag.sql) — an AI
  // row should never be HOF-flagged in the first place, but this keeps the
  // public Hall of Fame page safe even if one ever is by mistake.
  return restGet<HallOfFameDriverInfo[]>(env, 'drivers?select=id,bio&is_hall_of_fame=eq.true&is_ai=eq.false');
}

// --- Drivers editing their own profile (0104_driver_self_service_profile.sql) ---

export const DRIVER_BIO_MAX = 500;
export const DRIVER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** Accepted profile-photo types. SVG is deliberately not allowed for user uploads. */
export const DRIVER_AVATAR_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Uploads a driver's own profile photo to photos/driver-avatars/<driverId>/ (the only place storage policies let them write) and returns its public URL. */
export async function uploadDriverAvatar(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
  file: File,
): Promise<string> {
  const ext = DRIVER_AVATAR_TYPES[file.type];
  if (!ext) throw new Error('Unsupported image type');
  return uploadToStorage(env, accessToken, 'photos', `driver-avatars/${driverId}/${Date.now()}.${ext}`, file);
}

/** Saves the signed-in user's own bio (and photo, when given) through update_my_driver_profile(), which only touches their own linked driver row. */
export async function updateMyDriverProfile(
  env: SupabaseEnv,
  accessToken: string,
  data: { bio: string | null; photoUrl?: string },
): Promise<void> {
  const res = await fetch(`${env.url}/rest/v1/rpc/update_my_driver_profile`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_bio: data.bio,
      p_photo_url: data.photoUrl ?? null,
      p_set_photo: data.photoUrl !== undefined,
    }),
  });
  if (!res.ok) throw new Error(`Failed to update profile (${res.status}): ${await res.text()}`);
}

/**
 * Wraps a Supabase Storage image URL in a Cloudflare Transformations
 * request (`/cdn-cgi/image/...`) so it's resized/re-encoded on Cloudflare's
 * edge (`format=auto` picks WebP/AVIF per the visitor's Accept header)
 * instead of shipping every logo/photo at its original upload resolution —
 * see PERFORMANCE_AUDIT.md #4. Requires Images > Transformations enabled on
 * the zone AND this project's Supabase Storage host allow-listed under
 * Transformations > Sources (both dashboard-only, done once).
 *
 * Root-relative on purpose (no origin baked in): `/cdn-cgi/image/...`
 * resolves against whatever origin the page is served from, so this works
 * unmodified on production and any preview deployment alike. Local
 * `astro dev` has no Transformations in front of it, so these URLs would
 * 404 there — acceptable, since local dev never needs the optimization and
 * every other Supabase-hosted `<img>` already just points at the origin
 * file today.
 *
 * Only rewrites actual Supabase Storage URLs — anything else (flagcdn.com,
 * a relative path, null/undefined) passes through unchanged, since only
 * this project's Storage bucket is allow-listed as a source. Also passes
 * through unchanged if no width/height was requested — nothing to resize.
 */
export function resizedImageUrl(
  url: string | null | undefined,
  options: { width?: number; height?: number },
): string | null {
  if (!url) return null;
  if (!url.includes('.supabase.co/storage/v1/object/public/')) return url;
  if (!options.width && !options.height) return url;

  const params = ['format=auto', 'fit=scale-down'];
  if (options.width) params.push(`width=${options.width}`);
  if (options.height) params.push(`height=${options.height}`);
  return `/cdn-cgi/image/${params.join(',')}/${url}`;
}
