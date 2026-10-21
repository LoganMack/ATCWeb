import type { SupabaseEnv } from '../db/client';
import type { Season } from '../db/seasons';
import {
  getOrganizations,
  getAllOrganizationTeamSeasons,
  type Organization,
  type OrganizationTeamSeason,
} from '../db/teams';
import type { Lookup } from '../db/lookups';
import { computeDriverCareerStats, type DriverCareerStats } from './careerStats';

// ---------------------------------------------------------------------------
// Career team stats — every team that has ever fielded a driver, with
// career totals and a season-by-season breakdown. Powers the "Team Stats"
// history tab (src/pages/team-stats.astro).
//
// Deliberately NOT a second whole-history computation — it's a pure
// in-memory pivot of computeDriverCareerStats' own output (issues zero
// extra Supabase queries), attributing each driver-season's stat line to
// that driver's PRIMARY team that season (DriverCareerSeasonRow.teams[0] —
// same "primary team" a driver's own Team Pos/Delta Team Pos columns
// already use). A driver with no team that season contributes to no team's
// totals. This intentionally rolls up individual results rather than
// re-deriving team-level wins/podiums/etc. from scratch, since this site's
// team championship (see computeTeamSeasonStandings) only ever scores
// POINTS at the team level (top-2-scorers-per-race) — there's no separate
// notion of a "team win" or "team pole" independent of its drivers' own
// results to compute in the first place.
// ---------------------------------------------------------------------------

export interface TeamCareerSeasonDriver {
  driverId: string;
  name: string;
  carNumber: number | null;
  className: string;
  starts: number;
  nationality1: string | null;
  nationality2: string | null;
}

/** One team's stat line for one season, rolled up from every driver whose PRIMARY team that season was this one (in the `'delta'` view — see `computeTeamCareerStats`'s own doc comment — only from drivers who raced Delta that season). */
export interface TeamCareerSeasonRow {
  season: Season;
  /** The actual team that fielded drivers THIS season — for an org-linked row (see TeamCareerStats.teamName's own comment), this can differ season to season even though every row here is grouped under one organization name/logo (e.g. "Double Yellow" the org vs. "Yellow Tide Racing" the team that represented it in ATC13). For a team that's never been part of an organization this is just that team's own (single) name, same as the parent row's teamName. */
  teamName: string;
  /** This specific season's team logo — same per-season provenance as teamName above (0019_team_season_logos.sql's historical-logo override when set, else that team's current logo), NOT necessarily the same image as the parent row's logoUrl. */
  logoUrl: string | null;
  /** This team's position in that season's cross-class Overall Team Standings — 1 means they won the team championship that season. Null if, unusually, they had a primary-team driver but never appear there (shouldn't normally happen). Always the OVERALL position regardless of `view` — see deltaTeamPosition for the Delta-only equivalent. */
  teamPosition: number | null;
  /** Same idea, the Delta-only team competition's position — null if not applicable (see DriverCareerSeasonRow.deltaTeamPosition's own doc comment). */
  deltaTeamPosition: number | null;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  starts: number;
  appearances: number;
  laps: number;
  lapsLed: number;
  incidents: number;
  totalCorners: number | null;
  /** Count of this season's roster (below) who won their own class's championship that season — e.g. a team fielding that season's Alpha AND Delta champion counts 2 here, not 1. */
  driverChampionships: number;
  /** This team's roster that season (every driver whose primary team it was), most races first — a team can span multiple classes at once, so this carries each driver's own class rather than the row having one. In the `'delta'` view this is already narrowed to just that season's Delta driver(s). */
  drivers: TeamCareerSeasonDriver[];
}

export interface TeamCareerStats {
  /** An organization id when this row represents a linked group of renamed teams (see 0043_organizations.sql), or just the team's own id when it was never linked to an organization. Not consumed anywhere outside this file's own computation today, but kept as a stable identity for the row. */
  teamId: string;
  /** The organization's name when linked; otherwise this team's own (single, current) name — unaffected either way for a team that's never been part of an organization. */
  teamName: string;
  /** From the most recent season this team (or, for a linked organization, whichever team represented it that season) fielded a primary-team driver — teams don't have a single fixed logo (see 0019_team_season_logos.sql), so this is "their most current one on file," same reasoning DriverCareerStats uses the drivers table's own current name/photo for a driver spanning many seasons. In the `'delta'` view, "most recent" means most recent season they fielded a Delta driver. */
  logoUrl: string | null;
  /** Count of seasons this team finished 1st in the Overall Team Standings (view `'overall'`) or the Delta Team competition (view `'delta'`) — see `computeTeamCareerStats`'s `view` param. */
  championships: number;
  wins: number;
  podiums: number;
  poles: number;
  top5s: number;
  top10s: number;
  laps: number;
  lapsLed: number;
  starts: number;
  appearances: number;
  cornersPerIncident: number | null;
  /** Career sum of each season's driverChampionships — how many individual class titles this team's drivers have won while racing for it (view `'delta'` counts only Delta-class titles, since that view only rolls up Delta-class driver-seasons in the first place). */
  driverChampionships: number;
  /** Newest season first. */
  seasons: TeamCareerSeasonRow[];
}

export async function computeTeamCareerStats(
  env: SupabaseEnv,
  seasons: Season[],
  classes: Lookup[],
  exhibitionRoundIds?: Set<number>,
  /** Skip this function's own computeDriverCareerStats call and pivot an already-fetched result instead — same sharing reasoning as this whole file's other `precomputed*` params. */
  precomputedDriverCareerStats?: DriverCareerStats[],
  /** Same sharing reasoning — skip the organizations/links fetch when a caller already has them. */
  precomputedOrganizations?: Organization[],
  precomputedOrgTeamSeasons?: OrganizationTeamSeason[],
  /**
   * `'overall'` (default): every driver-season a team ever fielded, same as
   * always — the cross-class competition, and its `championships` count
   * comes from `teamPosition === 1`.
   * `'delta'`: only driver-seasons where that driver raced Delta that
   * season contribute at all (a team with no Delta driver in a given season
   * simply has no row for it, and drops out of the whole list if it NEVER
   * fielded one) — wins/podiums/etc. above are already per-driver-season
   * totals scoped to that driver's own class (see DriverCareerSeasonRow's
   * own doc comment), so restricting the input rows to Delta is sufficient
   * to make every rolled-up number here reflect Delta-class performance
   * only. `championships` switches to `deltaTeamPosition === 1` (the
   * standalone Delta Team competition — see computeTeamSeasonStandings'
   * own doc comment for how that differs from the Delta driver class
   * existing at all).
   */
  view: 'overall' | 'delta' = 'overall',
): Promise<TeamCareerStats[]> {
  const [driverCareerStats, organizations, orgTeamSeasons] = await Promise.all([
    precomputedDriverCareerStats
      ? Promise.resolve(precomputedDriverCareerStats)
      : computeDriverCareerStats(env, seasons, classes, exhibitionRoundIds),
    precomputedOrganizations ? Promise.resolve(precomputedOrganizations) : getOrganizations(env),
    precomputedOrgTeamSeasons
      ? Promise.resolve(precomputedOrgTeamSeasons)
      : getAllOrganizationTeamSeasons(env),
  ]);

  // (team_id, season_id) -> organization_id — a team that's never been
  // linked to an organization (the common case) simply has no entry here,
  // and computeTeamCareerStats' whole grouping step below reduces to
  // "everyone is grouped by their own team_id," i.e. today's behavior,
  // unchanged (see 0043_organizations.sql).
  const orgIdByTeamSeason = new Map<string, string>();
  for (const link of orgTeamSeasons) {
    orgIdByTeamSeason.set(`${link.team_id}:${link.season_id}`, link.organization_id);
  }
  const orgById = new Map(organizations.map((o) => [o.id, o]));

  interface TeamSeasonAccum {
    season: Season;
    teamName: string;
    logoUrl: string | null;
    teamPosition: number | null;
    deltaTeamPosition: number | null;
    wins: number;
    podiums: number;
    top5s: number;
    top10s: number;
    poles: number;
    starts: number;
    appearances: number;
    laps: number;
    lapsLed: number;
    incidents: number;
    totalCorners: number;
    anyCornersResolved: boolean;
    driverChampionships: number;
    drivers: TeamCareerSeasonDriver[];
  }
  // teamId -> seasonId -> that team's accumulated stats for that season
  const bySeasonByTeam = new Map<string, Map<string, TeamSeasonAccum>>();

  for (const driverStats of driverCareerStats) {
    for (const row of driverStats.seasons) {
      if (view === 'delta' && row.className !== 'Delta') continue;

      const primaryTeam = row.teams[0];
      if (!primaryTeam) continue; // no team that season — doesn't contribute to any team's stats

      if (!bySeasonByTeam.has(primaryTeam.teamId)) bySeasonByTeam.set(primaryTeam.teamId, new Map());
      const bySeasonId = bySeasonByTeam.get(primaryTeam.teamId)!;
      let accum = bySeasonId.get(row.season.id);
      if (!accum) {
        accum = {
          season: row.season,
          teamName: primaryTeam.teamName,
          logoUrl: primaryTeam.logoUrl,
          teamPosition: row.teamPosition,
          deltaTeamPosition: row.deltaTeamPosition,
          wins: 0,
          podiums: 0,
          top5s: 0,
          top10s: 0,
          poles: 0,
          starts: 0,
          appearances: 0,
          laps: 0,
          lapsLed: 0,
          incidents: 0,
          totalCorners: 0,
          anyCornersResolved: false,
          driverChampionships: 0,
          drivers: [],
        };
        bySeasonId.set(row.season.id, accum);
      }

      accum.wins += row.wins;
      accum.podiums += row.podiums;
      accum.top5s += row.top5s;
      accum.top10s += row.top10s;
      accum.poles += row.poles;
      accum.starts += row.starts;
      accum.appearances += row.appearances;
      accum.laps += row.laps;
      accum.lapsLed += row.lapsLed;
      accum.incidents += row.incidents;
      if (row.totalCorners !== null) {
        accum.totalCorners += row.totalCorners;
        accum.anyCornersResolved = true;
      }
      // Same "don't credit a still-in-progress season" gate as
      // aggregateDriverCareerStats' own championships counter above.
      if (row.classPosition === 1 && !row.season.is_current) accum.driverChampionships += 1;
      accum.drivers.push({
        driverId: driverStats.driver.id,
        name: driverStats.driver.name,
        carNumber: driverStats.driver.car_number,
        className: row.className,
        starts: row.starts,
        nationality1: driverStats.driver.nationality_1,
        nationality2: driverStats.driver.nationality_2,
      });
    }
  }

  // Regroup the per-(team, season) accumulations above by organization —
  // a team+season with no organization link falls back to its own team_id
  // as a singleton group key, so an unlinked team's output row is identical
  // to what this function produced before organizations existed.
  interface GroupedAccum extends TeamSeasonAccum {
    teamId: string;
  }
  const bySeasonByGroup = new Map<string, GroupedAccum[]>();
  for (const [teamId, bySeasonId] of bySeasonByTeam) {
    for (const [seasonId, accum] of bySeasonId) {
      const groupKey = orgIdByTeamSeason.get(`${teamId}:${seasonId}`) ?? `team:${teamId}`;
      if (!bySeasonByGroup.has(groupKey)) bySeasonByGroup.set(groupKey, []);
      bySeasonByGroup.get(groupKey)!.push({ ...accum, teamId });
    }
  }

  const out: TeamCareerStats[] = [];
  for (const [groupKey, groupAccums] of bySeasonByGroup) {
    const accums = groupAccums.sort((a, b) => b.season.number - a.season.number);
    const organization = groupKey.startsWith('team:') ? null : (orgById.get(groupKey) ?? null);
    const seasonRows: TeamCareerSeasonRow[] = accums.map((a) => ({
      season: a.season,
      teamName: a.teamName,
      logoUrl: a.logoUrl,
      teamPosition: a.teamPosition,
      deltaTeamPosition: a.deltaTeamPosition,
      wins: a.wins,
      podiums: a.podiums,
      top5s: a.top5s,
      top10s: a.top10s,
      poles: a.poles,
      starts: a.starts,
      appearances: a.appearances,
      laps: a.laps,
      lapsLed: a.lapsLed,
      incidents: a.incidents,
      totalCorners: a.anyCornersResolved ? a.totalCorners : null,
      driverChampionships: a.driverChampionships,
      drivers: [...a.drivers].sort((x, y) => y.starts - x.starts),
    }));

    let championships = 0;
    let wins = 0;
    let podiums = 0;
    let poles = 0;
    let top5s = 0;
    let top10s = 0;
    let laps = 0;
    let lapsLed = 0;
    let starts = 0;
    let appearances = 0;
    let totalCorners = 0;
    let totalIncidents = 0;
    let anyCornersResolved = false;
    let driverChampionships = 0;

    for (const r of seasonRows) {
      const teamTitlePosition = view === 'delta' ? r.deltaTeamPosition : r.teamPosition;
      // Same "don't credit a still-in-progress season" gate as
      // aggregateDriverCareerStats' own championships counter.
      if (teamTitlePosition === 1 && !r.season.is_current) championships++;
      wins += r.wins;
      podiums += r.podiums;
      poles += r.poles;
      top5s += r.top5s;
      top10s += r.top10s;
      laps += r.laps;
      lapsLed += r.lapsLed;
      starts += r.starts;
      appearances += r.appearances;
      totalIncidents += r.incidents;
      driverChampionships += r.driverChampionships;
      if (r.totalCorners !== null) {
        totalCorners += r.totalCorners;
        anyCornersResolved = true;
      }
    }

    // accums[0] is the most recent season (sorted above) — its logo
    // represents this team (or, when grouped, whichever team most recently
    // represented the organization) "as it is now" for the card header,
    // same reasoning DriverCareerStats uses a driver's current photo_url
    // for a driver spanning many seasons. The name, though, comes from the
    // organization itself when linked (that's the whole point — an
    // organization's own name doesn't change just because the team
    // representing it this season did), falling back to the team's own
    // name when there's no organization.
    out.push({
      teamId: organization?.id ?? accums[0].teamId,
      teamName: organization?.name ?? accums[0].teamName,
      logoUrl: accums[0].logoUrl,
      championships,
      wins,
      podiums,
      poles,
      top5s,
      top10s,
      laps,
      lapsLed,
      starts,
      appearances,
      cornersPerIncident: anyCornersResolved && totalIncidents > 0 ? totalCorners / totalIncidents : null,
      driverChampionships,
      seasons: seasonRows,
    });
  }

  out.sort((a, b) => a.teamName.localeCompare(b.teamName));
  return out;
}
