import { restDelete, restGet, restPatch, restPost, writeHeaders, type SupabaseEnv } from './client';
import { memoized } from '../requestMemo';

// --- Teams -------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  primary_color_hex: string | null;
  logo_url: string | null;
  /** Row-creation timestamp — NOT necessarily when the team was actually "founded" in league history (a team's row can be created well after their first season raced, e.g. on a data migration). See the public Teams page's "Founded" column, which takes the later of this and the team's earliest team_rosters season. */
  created_at: string;
}

/** All teams (active + inactive) — the public Teams page splits them into two sections itself. */
export function getTeams(env: SupabaseEnv) {
  return restGet<Team[]>(
    env,
    'teams?select=id,name,status,primary_color_hex,logo_url,created_at&order=name.asc',
  );
}

export async function getTeamById(env: SupabaseEnv, id: string) {
  const teams = await restGet<Team[]>(
    env,
    `teams?select=id,name,status,primary_color_hex,logo_url,created_at&id=eq.${encodeURIComponent(id)}`,
  );
  return teams[0] ?? null;
}

export function createTeam(env: SupabaseEnv, accessToken: string, data: Partial<Team>) {
  return restPost<Team>(env, accessToken, 'teams', data);
}

export function updateTeam(env: SupabaseEnv, accessToken: string, id: string, data: Partial<Team>) {
  return restPatch<Team>(env, accessToken, `teams?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteTeam(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `teams?id=eq.${encodeURIComponent(id)}`);
}

// --- Organizations (persistent identity across team renames, see 0043_organizations.sql) -

export interface Organization {
  id: string;
  name: string;
}

export interface OrganizationTeamSeason {
  id: string;
  organization_id: string;
  team_id: string;
  season_id: string;
}

export function getOrganizations(env: SupabaseEnv) {
  return restGet<Organization[]>(env, 'organizations?select=id,name&order=name.asc');
}

export async function getOrganizationById(env: SupabaseEnv, id: string) {
  const orgs = await restGet<Organization[]>(
    env,
    `organizations?select=id,name&id=eq.${encodeURIComponent(id)}`,
  );
  return orgs[0] ?? null;
}

/**
 * Every organization<->team season link, fetched once by computeTeamCareerStats
 * (src/lib/results/teamCareer.ts).
 */
export function getAllOrganizationTeamSeasons(env: SupabaseEnv) {
  return restGet<OrganizationTeamSeason[]>(
    env,
    'organization_team_seasons?select=id,organization_id,team_id,season_id',
  );
}

export function getOrganizationTeamSeasons(env: SupabaseEnv, organizationId: string) {
  return restGet<OrganizationTeamSeason[]>(
    env,
    `organization_team_seasons?select=id,organization_id,team_id,season_id&organization_id=eq.${encodeURIComponent(organizationId)}`,
  );
}

export function createOrganization(env: SupabaseEnv, accessToken: string, data: { name: string }) {
  return restPost<Organization>(env, accessToken, 'organizations', data);
}

export function updateOrganization(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: { name: string },
) {
  return restPatch<Organization>(env, accessToken, `organizations?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteOrganization(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `organizations?id=eq.${encodeURIComponent(id)}`);
}

/**
 * Sets or clears the team representing an organization for one season. Two uniqueness rules (0043) mean the
 * existing (org, season) and (team, season) claims are released before inserting; `teamId: null` only clears.
 */
export async function setOrganizationTeamForSeason(
  env: SupabaseEnv,
  accessToken: string,
  organizationId: string,
  seasonId: string,
  teamId: string | null,
) {
  await restDelete(
    env,
    accessToken,
    `organization_team_seasons?organization_id=eq.${encodeURIComponent(organizationId)}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
  if (!teamId) return;
  await restDelete(
    env,
    accessToken,
    `organization_team_seasons?team_id=eq.${encodeURIComponent(teamId)}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
  await restPost<OrganizationTeamSeason>(env, accessToken, 'organization_team_seasons', {
    organization_id: organizationId,
    team_id: teamId,
    season_id: seasonId,
  });
}

// --- Team rosters (season-scoped team membership, max 4 drivers/team/season, see 0008_team_rosters.sql) -

export interface TeamRosterEntry {
  season_id: string;
  team_id: string;
  driver_id: string;
}

const TEAM_ROSTER_SELECT = 'season_id,team_id,driver_id';

/** Every roster entry across every team for one season. */
export function getTeamRosterForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<TeamRosterEntry[]>(
    env,
    `team_rosters?select=${TEAM_ROSTER_SELECT}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

/** One team's roster entries for one season (at most 4, enforced server-side). */
export function getTeamRosterForTeamSeason(env: SupabaseEnv, teamId: string, seasonId: string) {
  return restGet<TeamRosterEntry[]>(
    env,
    `team_rosters?select=${TEAM_ROSTER_SELECT}&team_id=eq.${encodeURIComponent(teamId)}&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

/** Every roster entry across every team AND every season — a small table, fetched whole. Used by the public Teams page to find each team's earliest season (for the "Founded" column) without a per-team round trip. */
export function getAllTeamRosters(env: SupabaseEnv) {
  return restGet<TeamRosterEntry[]>(env, `team_rosters?select=${TEAM_ROSTER_SELECT}`);
}

/** Adds one driver to a team's roster for a season. Throws (with the trigger's own message) if the team's already at 4, or the driver's already on another team that season. */
export function addTeamRosterEntry(env: SupabaseEnv, accessToken: string, data: TeamRosterEntry) {
  return restPost<TeamRosterEntry>(env, accessToken, 'team_rosters', data);
}

export function removeTeamRosterEntry(env: SupabaseEnv, accessToken: string, data: TeamRosterEntry) {
  return restDelete(
    env,
    accessToken,
    `team_rosters?season_id=eq.${encodeURIComponent(data.season_id)}&team_id=eq.${encodeURIComponent(data.team_id)}&driver_id=eq.${encodeURIComponent(data.driver_id)}`,
  );
}

export interface TeamRosterWithTeam {
  driver_id: string;
  teams: { id: string; name: string; primary_color_hex: string | null; logo_url: string | null } | null;
}

/**
 * Every driver's team for one season from team_rosters, which admins maintain and scoring trusts (0045), not
 * drivers.team_id, which drifts. Pages showing a driver's current team should use this for the current
 * season.
 */
export function getTeamRosterWithTeamsForSeason(env: SupabaseEnv, seasonId: string) {
  return restGet<TeamRosterWithTeam[]>(
    env,
    `team_rosters?select=driver_id,teams(id,name,primary_color_hex,logo_url)&season_id=eq.${encodeURIComponent(seasonId)}`,
  );
}

// --- Team season logos (historical logos, see 0019_team_season_logos.sql) -

export interface TeamSeasonLogo {
  id: string;
  team_id: string;
  season_id: string;
  logo_url: string;
}

const TEAM_SEASON_LOGO_SELECT = 'id,team_id,season_id,logo_url';

/** One team's historical logo overrides, across every season it has one for — powers the "Logos by Season" list on the admin team edit page. */
export function getTeamSeasonLogosForTeam(env: SupabaseEnv, teamId: string) {
  return restGet<TeamSeasonLogo[]>(
    env,
    `team_season_logos?select=${TEAM_SEASON_LOGO_SELECT}&team_id=eq.${encodeURIComponent(teamId)}`,
  );
}

/** Every team's per-season logo overrides in one query, for resolveTeamLogo() in src/lib/results/rows.ts. */
export function getAllTeamSeasonLogos(env: SupabaseEnv) {
  return memoized(env, 'getAllTeamSeasonLogos', [], () =>
    restGet<TeamSeasonLogo[]>(env, `team_season_logos?select=${TEAM_SEASON_LOGO_SELECT}`),
  );
}

/** Upserts the logo for one (team, season) — replaces whatever override was set for that season before, but never touches the team's current logo (teams.logo_url) or any other season's override. */
export async function upsertTeamSeasonLogo(
  env: SupabaseEnv,
  accessToken: string,
  data: { team_id: string; season_id: string; logo_url: string },
) {
  const res = await fetch(`${env.url}/rest/v1/team_season_logos?on_conflict=team_id,season_id`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken, { Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error(`Supabase upsert error ${res.status} on team_season_logos: ${await res.text()}`);
  const rows = (await res.json()) as TeamSeasonLogo[];
  return rows[0];
}

export function deleteTeamSeasonLogo(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `team_season_logos?id=eq.${encodeURIComponent(id)}`);
}
