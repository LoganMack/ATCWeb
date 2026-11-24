/**
 * The Lineup Changes fragment's reads (U9; NFR1.2): seven requests in two waves. Wave 1 finds the seasons and
 * rosters; wave 2 (car numbers and masked names) runs only when there is a board to draw. Membership comes
 * from team_rosters alone (BR1.6), and names only from drivers_shown (BR1.15). A failed read throws.
 */
import type { SupabaseEnv } from '../db/client';
import { getDriverSeasonCarNumbersForSeason, getShownDriversByIds } from '../db/drivers';
import { getSeasons } from '../db/seasons';
import { getAllTeamRosters, getAllTeamSeasonLogos, getTeams } from '../db/teams';
import { buildSeasonLogoMap } from '../results/rows';
import { buildLineupBoard, lineupMessage, type LineupBoard } from './board';
import { classifyLineups, previousSeason, resolveLineupSeason } from './classify';

export async function loadLineups(env: SupabaseEnv, seasonParam: string | null): Promise<LineupBoard> {
  const [seasons, rosters, teams, logos] = await Promise.all([
    getSeasons(env),
    getAllTeamRosters(env),
    getTeams(env),
    getAllTeamSeasonLogos(env),
  ]);

  const season = resolveLineupSeason(seasonParam, seasons, new Set(rosters.map((r) => r.season_id)));
  const previous = season ? previousSeason(season, seasons) : null;
  const current = season ? rosters.filter((r) => r.season_id === season.id) : [];
  const before = previous ? rosters.filter((r) => r.season_id === previous.id) : [];
  const message = lineupMessage(season, previous, current.length > 0, before.length > 0);
  if (message || !season || !previous) return { kind: 'message', text: message ?? '' };

  const earlierSeasonIds = new Set(seasons.filter((s) => s.number < previous.number).map((s) => s.id));
  const earlierDriverIds = new Set(
    rosters.filter((r) => earlierSeasonIds.has(r.season_id)).map((r) => r.driver_id),
  );
  const driverIds = [...new Set([...current, ...before].map((r) => r.driver_id))];

  const [currentNumbers, previousNumbers, drivers] = await Promise.all([
    getDriverSeasonCarNumbersForSeason(env, season.id),
    getDriverSeasonCarNumbersForSeason(env, previous.id),
    getShownDriversByIds(env, driverIds),
  ]);

  const teamNames = new Map(teams.map((t) => [t.id, t.name]));
  const classified = classifyLineups({
    current,
    previous: before,
    earlierDriverIds,
    teamName: (id) => teamNames.get(id) ?? id,
  });
  return buildLineupBoard({
    season,
    previous,
    classified,
    teams,
    drivers,
    currentNumbers,
    previousNumbers,
    seasonLogos: buildSeasonLogoMap(logos),
  });
}
