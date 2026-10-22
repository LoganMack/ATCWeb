import { restDelete, restGet, restPatch, restPost, writeHeaders, type SupabaseEnv } from './client';

// ---------------------------------------------------------------------------
// SEASONS
// ---------------------------------------------------------------------------

export interface Season {
  id: string;
  number: number;
  name: string;
  logo_url: string | null;
  /**
   * Light-mode variant of `logo_url` (0089_season_light_logo.sql) —
   * `logo_url` itself is treated as the dark-mode logo everywhere it's
   * shown (every logo an admin uploaded before the light/dark toggle
   * existed is a dark-mode logo). Null just means no light variant has
   * been uploaded yet, in which case every render site keeps showing the
   * dark logo in light mode too (see SeasonLogo.astro) rather than
   * showing nothing.
   */
  logo_url_light: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  /**
   * Drop weeks beyond the standard baseline (see src/lib/results.ts —
   * standings drop each driver's worst 2 + extra_drop_weeks rounds before
   * totaling points). Column lives on `seasons` in the live database
   * already; not created by this repo's migrations (see 0004_champions.sql
   * for why).
   */
  extra_drop_weeks: number;
  /**
   * Which scoring_ruleset applies to this season — null means "use whichever
   * ruleset is marked default" (see ScoringRuleset.is_default / resolveSeasonRuleset
   * below), not "no ruleset at all." Column lives on `seasons` in the live
   * database already (0031_scoring_rulesets_default.sql only added
   * scoring_rulesets.is_default/updated_at, not this column); admin-editable
   * from /admin/seasons.
   */
  scoring_ruleset_id: string | null;
  /** Whether the Gamma class competed this season — see 0037_class_and_scoring_fixes.sql. Gamma didn't exist before ATC16, so this is false for older seasons unless an admin turns it on. Controls whether Gamma standings/champions/tabs show for this season on the public site. */
  gamma_enabled: boolean;
  /** Same idea as gamma_enabled, for Delta — didn't exist before ATC5. */
  delta_enabled: boolean;
  /**
   * Whether the separate Delta TEAM championship ran this season — see
   * 0052_delta_team_enabled.sql. NOT the same thing as delta_enabled: the
   * Delta driver class existed from ATC5, but the standalone Delta Team
   * competition/standings (shown alongside "Alpha Team" on /champions and
   * /team-standings) didn't start until ATC10. Controls whether Delta Team
   * standings/champions/positions show for this season on the public site.
   */
  delta_team_enabled: boolean;
}

/**
 * A season's logo pair as passed into SeasonLogo.astro — used by every page
 * that builds a `season name -> logo` lookup (news_label isn't an FK to
 * `seasons`, so these are best-effort name-matched maps rather than joins;
 * see news/index.astro, index.astro, drivers/[id]/fragment.astro).
 */
export interface SeasonLogoPair {
  dark: string;
  light: string | null;
}

const SEASON_SELECT =
  'id,number,name,logo_url,logo_url_light,start_date,end_date,is_current,extra_drop_weeks,scoring_ruleset_id,gamma_enabled,delta_enabled,delta_team_enabled';

/** All seasons, newest first. */
export function getSeasons(env: SupabaseEnv) {
  return restGet<Season[]>(env, `seasons?select=${SEASON_SELECT}&order=number.desc`);
}

export async function getSeasonById(env: SupabaseEnv, id: string) {
  const seasons = await restGet<Season[]>(
    env,
    `seasons?select=${SEASON_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return seasons[0] ?? null;
}

/**
 * Sets (or clears, with `null`) a season's dark-mode and/or light-mode logo
 * — the only fields seasons can be admin-edited from (0024_season_logos_and_page_banners.sql,
 * 0089_season_light_logo.sql). Pass only the field(s) that actually changed
 * — `logo_url`/`logo_url_light` are each independently optional, so e.g.
 * removing just the light variant doesn't touch the dark one.
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
 * Admin > Seasons' "Recalculate" button — rescores every round in a season
 * into race_score_results via the admin-checked rescore_season() (BR3.4),
 * rather than looping N individual RPC calls from here (one round trip
 * instead of N, and the whole run stays inside one Postgres statement so a
 * slow round can't leave the UI hanging on a partially-done season).
 * A round-level failure doesn't abort the batch — it comes back as its own
 * row with `error_message` set, right alongside the rounds that succeeded,
 * so the caller can report exactly which rounds still need attention
 * (a missing ruleset, a round with no format set, etc.) instead of an
 * all-or-nothing outcome.
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
  if (!res.ok)
    throw new Error(`Supabase RPC error ${res.status} on rescore_season: ${await res.text()}`);
  return res.json() as Promise<SeasonRecalcResult[]>;
}

/**
 * Marks one season as the current one (is_current=true), the season the
 * public site's pickers default to (see standings.astro/team-standings.astro/
 * results.astro all falling back to `seasons.find((s) => s.is_current)`).
 * `seasons` has a partial unique index enforcing at most one is_current=true
 * row at a time (0001_init.sql) — so the old current season has to be
 * cleared to false FIRST, then the new one set to true, or the second PATCH
 * would violate that index while the old row is still true. Two requests,
 * not a transaction, since PostgREST doesn't expose one for plain REST
 * calls — a failure between them would leave no season marked current
 * rather than two, which is the safer of the two ways this could go wrong.
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

// --- Scoring rulesets (see 0031_scoring_rulesets_default.sql) --------------
//
// A ruleset's `rules` jsonb is what the DB-side score_round()
// function reads to actually compute race_score_results from raw curated_race_results
// (base points per finish position, class-podium bonuses, Sublime Finesse,
// Class Pole, PP-penalty point deductions, drop-week count, team roster
// size/eligibility — see that function for the exact shape). This app treats
// it as an opaque JSON blob (edited as raw text in the admin UI) rather than
// modeling every field, since nothing in this repo's own TypeScript
// re-derives points from it today — see resolveSeasonRuleset's own doc
// comment for what "applying" a ruleset currently means app-side.

export interface ScoringRuleset {
  id: string;
  name: string;
  /**
   * Parsed JSON (an object), NOT a string — PostgREST returns jsonb columns
   * as native JSON on every read (GET, and the `return=representation` body
   * of a create/update), same as any other jsonb column in this file.
   * Treating this field as a string (it used to be typed that way) fed an
   * already-parsed object into `JSON.parse`, which fails and falls through
   * to the object's default `[object Object]` stringification — see
   * splitRulesForForm() in src/pages/admin/rulesets/index.astro, which
   * guards against a non-object `rules` value (e.g. a row corrupted by the
   * bug described below) when prefilling the ruleset editor dialog.
   *
   * createScoringRuleset/updateScoringRuleset's `rules` param below is ALSO
   * typed `unknown` (a parsed object), not a JSON string — a previous
   * version of this comment claimed the write side should send a
   * JSON-stringified string because "Postgres's ::jsonb cast re-parses that
   * string back into the real object on the way in." That's wrong, and it
   * corrupted this exact column in production: PostgREST doesn't run the
   * request body through Postgres's jsonb TEXT INPUT parser at all — it
   * extracts each field's value from the parsed JSON request body and hands
   * it to the target column already typed as JSON. A JSON *string* value
   * (e.g. `"rules": "{\"drops\":2,...}"`) lands in a jsonb column as a
   * STRING SCALAR whose content happens to look like JSON — it is NOT
   * re-parsed into an object. That's silent: no error, just a
   * `scoring_rulesets.rules` row that reads back as `jsonb_typeof = 'string'`
   * instead of `'object'`, so every `v_rules->'base_points'->...` lookup in
   * score_round() evaluates to SQL NULL — and every round of a season using
   * that ruleset is then recorded in scoring_issues ("no base_points")
   * instead of being scored, which is easy to miss until results go
   * missing. Sending the PARSED OBJECT (not a string) as `rules` is what makes
   * PostgREST forward it as an actual JSON object value.
   */
  rules: unknown;
  /** At most one ruleset can have this true at a time (partial unique index) — the ruleset a season falls back to when its own scoring_ruleset_id is null. See resolveSeasonRuleset. */
  is_default: boolean;
  /**
   * Whether the drop-week mechanic (src/lib/results.ts's finalizeStandings)
   * is allowed to drop the season's final round for driver standings.
   * `false` PROTECTS the final round — it's always counted, never one of
   * the worst-N dropped rounds. `true` (the DB column default as of
   * 0067_ruleset_overhaul_and_bonuses.sql — existing rulesets keep whatever
   * value they already had) treats it like any other round, eligible to be
   * dropped along with the rest. Read via resolveSeasonRuleset() in
   * computeSeasonStandings/computeOverallSeasonStandings — see
   * 0062_scoring_ruleset_can_drop_final_round.sql.
   */
  can_drop_final_round: boolean;
  created_at: string;
  updated_at: string;
}

const SCORING_RULESET_SELECT = 'id,name,rules,is_default,can_drop_final_round,created_at,updated_at';

/** All scoring rulesets, alphabetical. */
export function getScoringRulesets(env: SupabaseEnv) {
  return restGet<ScoringRuleset[]>(env, `scoring_rulesets?select=${SCORING_RULESET_SELECT}&order=name.asc`);
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
 * Marks one ruleset as THE default (the one seasons with no ruleset of their
 * own resolve to — see resolveSeasonRuleset). Same clear-then-set two-request
 * pattern as setCurrentSeason, for the same reason: the partial unique index
 * on is_default would reject setting a second row true while the old
 * default is still true.
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
 * Resolves which ruleset actually applies to a season: the one it's
 * explicitly assigned, or whichever is marked default if it isn't assigned
 * one. Returns null only if neither exists (no ruleset assigned AND no
 * default configured yet).
 *
 * IMPORTANT SCOPE NOTE: this app's own standings/career-stats/news-recap
 * computations (src/lib/results/) read already-computed `race_score_results`
 * rows — they don't re-derive POINTS from a ruleset's `rules` jsonb
 * themselves (that derivation lives entirely in the DB-side
 * score_round() function). So for point values, "resolving" a
 * season's ruleset is a season-metadata/admin-display concern (showing
 * which ruleset is in effect, and which season rows still need one before
 * scores can be (re)computed for them) — it does not change the point
 * totals any standings page shows.
 *
 * The one field that IS consulted directly by the standings computation
 * itself (not just the DB-side scoring function) is
 * `can_drop_final_round` — computeSeasonStandings/computeOverallSeasonStandings
 * call this same resolveSeasonRuleset() to decide whether a season's final
 * round is protected from the drop-week mechanic. See that field's own doc
 * comment on ScoringRuleset.
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
 * Round incident limit (item 6, 0067_ruleset_overhaul_and_bonuses.sql) —
 * informational only, no scoring effect. Pulled out of
 * results/[subsessionId].astro (where it originated, for an
 * already-imported round) so EventDetailCard.astro/calendar.astro can show
 * the same "15x"/"8x" figure for an EVENT, which may not have an imported
 * round/subsession_id yet — both reduce to the same
 * ruleset.rules.round_incident_limit.sprint/.endurance lookup, with a
 * per-subsession race_overrides escape hatch for special events (checked
 * first, same as base_points/classified_minimum overrides elsewhere).
 *
 * Read straight off `rules` (jsonb, typed `unknown` — see ScoringRuleset's
 * own doc comment) with defensive optional-chaining since nothing
 * guarantees its shape. Returns null whenever nothing resolves (no
 * ruleset, a 'special'/null format, or no matching override) —
 * deliberately not 0, since 0 would read as "no incidents allowed" rather
 * than "no limit configured".
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
