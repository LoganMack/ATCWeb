/**
 * Lineup Changes (U9): which season to show and how each driver's team changed between that season (S) and the
 * one before it (S-1), from the official season rosters only (BR1.3 to BR1.12). Pure: no reads, no markup.
 */
import { canonicalSeasonNumber } from '../compareRows';
import type { Season } from '../db/seasons';

export type LineupSeason = Pick<Season, 'id' | 'number' | 'name' | 'is_current'>;

export type LineupStatus = 'stayed' | 'moved' | 'joined' | 'left';

export interface RosterRow {
  season_id: string;
  team_id: string;
  driver_id: string;
}

export interface Classified {
  /** The roster's driver id: used inside src/lib only, never written to markup (BR1.15). */
  driverId: string;
  status: LineupStatus;
  /** Joined only: on a roster of a season before S-1 (BR1.10). */
  returning: boolean;
  /** S-1's team, for moved and left. */
  fromTeamId: string | null;
  /** S's team, for stayed, moved and joined. */
  toTeamId: string | null;
}

export interface ClassifyInput {
  current: readonly RosterRow[];
  previous: readonly RosterRow[];
  earlierDriverIds: ReadonlySet<string>;
  teamName: (teamId: string) => string;
}

function newestFirst<T extends LineupSeason>(seasons: readonly T[]): T[] {
  return [...seasons].sort((a, b) => b.number - a.number);
}

/**
 * S: the season asked for by number when it exists (BR1.3), else the current season when it has rosters, else
 * the latest season with rosters, else the current or newest season, which then shows "no lineups" (BR1.4).
 */
export function resolveLineupSeason<T extends LineupSeason>(
  value: string | null | undefined,
  seasons: readonly T[],
  seasonIdsWithRosters: ReadonlySet<string>,
): T | null {
  const number = canonicalSeasonNumber(value);
  const asked = number !== null ? seasons.find((s) => s.number === number) : undefined;
  if (asked) return asked;
  const ordered = newestFirst(seasons);
  const current = ordered.find((s) => s.is_current);
  if (current && seasonIdsWithRosters.has(current.id)) return current;
  return ordered.find((s) => seasonIdsWithRosters.has(s.id)) ?? current ?? ordered[0] ?? null;
}

/** S-1: the highest-numbered season below S, whether or not it has rosters; null for the first season (BR1.5). */
export function previousSeason<T extends LineupSeason>(
  season: LineupSeason,
  seasons: readonly T[],
): T | null {
  return newestFirst(seasons).find((s) => s.number < season.number) ?? null;
}

/**
 * driverId -> teamId for one season. The database allows one team per driver per season, so a duplicate is bad
 * data: keep the team whose name sorts first and log ids only, never names (BR1.7).
 */
function teamByDriver(rows: readonly RosterRow[], teamName: (teamId: string) => string): Map<string, string> {
  const teams = new Map<string, string[]>();
  for (const row of rows) {
    const list = teams.get(row.driver_id);
    if (list) {
      if (!list.includes(row.team_id)) list.push(row.team_id);
    } else teams.set(row.driver_id, [row.team_id]);
  }
  const out = new Map<string, string>();
  for (const [driverId, teamIds] of teams) {
    if (teamIds.length > 1) {
      teamIds.sort((a, b) => teamName(a).toLowerCase().localeCompare(teamName(b).toLowerCase()));
      const seasonId = rows.find((r) => r.driver_id === driverId)?.season_id;
      console.warn('Duplicate roster row', { seasonId, driverId, teamIds: [...teamIds] });
    }
    out.set(driverId, teamIds[0]);
  }
  return out;
}

/**
 * One entry per driver on either roster, compared by team id only, so a class change, a rename or a new car
 * number is never a change (BR1.8 to BR1.12). S's drivers come first in roster order, then S-1's leavers.
 */
export function classifyLineups(input: ClassifyInput): Classified[] {
  const prev = teamByDriver(input.previous, input.teamName);
  const cur = teamByDriver(input.current, input.teamName);
  const out: Classified[] = [];
  for (const [driverId, toTeamId] of cur) {
    const fromTeamId = prev.get(driverId) ?? null;
    if (fromTeamId === null) {
      out.push({
        driverId,
        status: 'joined',
        returning: input.earlierDriverIds.has(driverId),
        fromTeamId,
        toTeamId,
      });
    } else if (fromTeamId === toTeamId) {
      out.push({ driverId, status: 'stayed', returning: false, fromTeamId: null, toTeamId });
    } else {
      out.push({ driverId, status: 'moved', returning: false, fromTeamId, toTeamId });
    }
  }
  for (const [driverId, fromTeamId] of prev) {
    if (!cur.has(driverId))
      out.push({ driverId, status: 'left', returning: false, fromTeamId, toTeamId: null });
  }
  return out;
}
