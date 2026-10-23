import { restDelete, restGet, restPatch, restPost, writeHeaders, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

// ---------------------------------------------------------------------------
// SEASONS
// ---------------------------------------------------------------------------

export interface Season {
  id: string;
  number: number;
  name: string;
  logo_url: string | null;
  /**
   * Light-theme logo (0089); `logo_url` is the dark-theme one. When null, SeasonLogo.astro shows the dark
   * logo in light mode too.
   */
  logo_url_light: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  /**
   * Drop weeks on top of the ruleset's base (standingsCore.ts). The column exists in the live database but
   * not in this repo's migrations (see archive/00041_champions.sql).
   */
  extra_drop_weeks: number;
  /**
   * The season's scoring ruleset; null means the default ruleset (resolveSeasonRuleset). The column predates
   * this repo's migrations; edited on /admin/seasons.
   */
  scoring_ruleset_id: string | null;
  /** Whether the Gamma class competed this season — see 0037_class_and_scoring_fixes.sql. Gamma didn't exist before ATC16, so this is false for older seasons unless an admin turns it on. Controls whether Gamma standings/champions/tabs show for this season on the public site. */
  gamma_enabled: boolean;
  /** Same idea as gamma_enabled, for Delta — didn't exist before ATC5. */
  delta_enabled: boolean;
  /**
   * Whether the Delta Team championship ran this season (0052). Not delta_enabled: the Delta class began at
   * ATC5, the team championship at ATC10.
   */
  delta_team_enabled: boolean;
}

/**
 * A season's logo pair for SeasonLogo.astro. news_label isn't an FK to `seasons`, so pages build best-effort
 * name-matched lookups.
 */
export interface SeasonLogoPair {
  dark: string;
  light: string | null;
}

const SEASON_SELECT =
  'id,number,name,logo_url,logo_url_light,start_date,end_date,is_current,extra_drop_weeks,scoring_ruleset_id,gamma_enabled,delta_enabled,delta_team_enabled';

/** All seasons, newest first. */
export function getSeasons(env: SupabaseEnv) {
  return memoized(env, 'getSeasons', [], () =>
    restGet<Season[]>(env, `seasons?select=${SEASON_SELECT}&order=number.desc`),
  );
}

export async function getSeasonById(env: SupabaseEnv, id: string) {
  const seasons = await restGet<Season[]>(
    env,
    `seasons?select=${SEASON_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return seasons[0] ?? null;
}

/**
 * Sets or clears a season's dark and/or light logo (0024, 0089); each is optional, so pass only what changed.
 */
export async function updateSeasonLogo(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  logos: { logo_url?: string | null; logo_url_light?: string | null },
) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, logos);
}

/** Assigns (or clears, with `null`) which scoring ruleset a season uses — see Season.scoring_ruleset_id. */
export async function updateSeasonRuleset(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  rulesetId: string | null,
) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, {
    scoring_ruleset_id: rulesetId,
  });
}

/** Toggles a season's Gamma/Delta class-activation flags, plus the separate Delta Team championship flag — see Season.gamma_enabled/delta_enabled/delta_team_enabled. */
export async function updateSeasonClassFlags(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  flags: { gamma_enabled: boolean; delta_enabled: boolean; delta_team_enabled: boolean },
) {
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(id)}`, flags);
}

/** One curated_rounds row's outcome from a recalculateSeasonScores() call — per round rather than one pass/fail for the whole season. */
export interface SeasonRecalcResult {
  subsession_id: number;
  rows_written: number | null;
  error_message: string | null;
}

/**
 * Admin > Seasons "Recalculate": rescore_season() (BR3.4) rescores every round in one statement instead of N
 * calls. A failing round comes back as its own row with `error_message`, so the rest still succeed.
 */
export async function recalculateSeasonScores(
  env: SupabaseEnv,
  accessToken: string,
  seasonId: string,
): Promise<SeasonRecalcResult[]> {
  const res = await fetch(`${env.url}/rest/v1/rpc/rescore_season`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify({ p_season_id: seasonId }),
  });
  if (!res.ok) throw new Error(`Supabase RPC error ${res.status} on rescore_season: ${await res.text()}`);
  return res.json() as Promise<SeasonRecalcResult[]>;
}

/**
 * Makes a season current (the public pickers' default). A partial unique index allows one current season
 * (0001), so the old one is cleared first; if the second request fails, no season is current, which is the
 * safer failure.
 */
export async function setCurrentSeason(env: SupabaseEnv, accessToken: string, seasonId: string) {
  await restPatch<Season>(
    env,
    accessToken,
    `seasons?is_current=eq.true&id=neq.${encodeURIComponent(seasonId)}`,
    {
      is_current: false,
    },
  );
  await restPatch<Season>(env, accessToken, `seasons?id=eq.${encodeURIComponent(seasonId)}`, {
    is_current: true,
  });
}

// --- Scoring rulesets (0031_scoring_rulesets_default.sql) ---
// `rules` is read by the database's score_round(); the app keeps it as opaque JSON edited as text, since only
// can_drop_final_round is read app-side.

export interface ScoringRuleset {
  id: string;
  name: string;
  /**
   * A parsed JSON object, on reads and on writes. Sending it as a JSON string stores a jsonb string scalar,
   * which score_round() can't read, so every round of the season lands in scoring_issues instead of being
   * scored.
   */
  rules: unknown;
  /** At most one ruleset can have this true at a time (partial unique index) — the ruleset a season falls back to when its own scoring_ruleset_id is null. See resolveSeasonRuleset. */
  is_default: boolean;
  /**
   * Whether drop weeks may drop the season's final round (0062); false always counts it. The column defaults
   * to true since 0067. Read through resolveSeasonRuleset() by the standings computations.
   */
  can_drop_final_round: boolean;
  created_at: string;
  updated_at: string;
}

const SCORING_RULESET_SELECT = 'id,name,rules,is_default,can_drop_final_round,created_at,updated_at';

/** All scoring rulesets, alphabetical. */
export function getScoringRulesets(env: SupabaseEnv) {
  return memoized(env, 'getScoringRulesets', [], () =>
    restGet<ScoringRuleset[]>(env, `scoring_rulesets?select=${SCORING_RULESET_SELECT}&order=name.asc`),
  );
}

export function createScoringRuleset(
  env: SupabaseEnv,
  accessToken: string,
  data: { name: string; rules: unknown; can_drop_final_round?: boolean },
) {
  return restPost<ScoringRuleset>(env, accessToken, 'scoring_rulesets', data);
}

export function updateScoringRuleset(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<{ name: string; rules: unknown; can_drop_final_round: boolean }>,
) {
  return restPatch<ScoringRuleset>(
    env,
    accessToken,
    `scoring_rulesets?id=eq.${encodeURIComponent(id)}`,
    data,
  );
}

export function deleteScoringRuleset(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `scoring_rulesets?id=eq.${encodeURIComponent(id)}`);
}

/**
 * Makes a ruleset the default, clearing the old one first for the same partial-unique-index reason as
 * setCurrentSeason.
 */
export async function setDefaultScoringRuleset(env: SupabaseEnv, accessToken: string, rulesetId: string) {
  await restPatch<ScoringRuleset>(
    env,
    accessToken,
    `scoring_rulesets?is_default=eq.true&id=neq.${encodeURIComponent(rulesetId)}`,
    {
      is_default: false,
    },
  );
  await restPatch<ScoringRuleset>(
    env,
    accessToken,
    `scoring_rulesets?id=eq.${encodeURIComponent(rulesetId)}`,
    {
      is_default: true,
    },
  );
}

/**
 * The season's assigned ruleset, else the default; null if neither exists. Points come from the database's
 * score_round(), so in the app this only drives display and can_drop_final_round.
 */
export function resolveSeasonRuleset(
  season: Pick<Season, 'scoring_ruleset_id'>,
  rulesets: ScoringRuleset[],
): ScoringRuleset | null {
  if (season.scoring_ruleset_id) {
    const assigned = rulesets.find((r) => r.id === season.scoring_ruleset_id);
    if (assigned) return assigned;
  }
  return rulesets.find((r) => r.is_default) ?? null;
}

/**
 * Round incident limit (0067), informational only. Shared by the results page and the event cards, which may
 * have no round yet: a per-subsession race_overrides value first, then the ruleset's sprint/endurance value.
 * Null, never 0, when nothing is configured, since 0 would mean "no incidents allowed".
 */
export function resolveIncidentLimit(
  ruleset: ScoringRuleset | null,
  format: 'sprint' | 'endurance' | 'special' | null,
  subsessionId: number | null,
): number | null {
  const rules = (ruleset?.rules ?? null) as {
    round_incident_limit?: { sprint?: number; endurance?: number };
    race_overrides?: { subsession_ids?: number[]; incident_limit?: number };
  } | null;
  const override = rules?.race_overrides;
  if (
    subsessionId !== null &&
    override?.subsession_ids?.includes(subsessionId) &&
    typeof override.incident_limit === 'number'
  ) {
    return override.incident_limit;
  }
  if (format === 'sprint' && typeof rules?.round_incident_limit?.sprint === 'number') {
    return rules.round_incident_limit.sprint;
  }
  if (format === 'endurance' && typeof rules?.round_incident_limit?.endurance === 'number') {
    return rules.round_incident_limit.endurance;
  }
  return null;
}
