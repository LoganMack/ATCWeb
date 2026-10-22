/**
 * Season standings, champions and race results, read from the external pipeline's tables (curated_*) and the
 * scores the database derives from them (race_score_results_public, filled by score_round()).
 * - Season totals drop each driver's worst N rounds (the ruleset's drops.base, 2 by default, plus
 *   `seasons.extra_drop_weeks`); a round's races drop as one unit and at least one round always counts.
 * - Poles come from the stored pole bonus (race 1 only), counted once per round: "poles are based on
 *   appearances, not starts."
 */

import type { Season } from '../db/seasons';

/**
 * Real championship seasons are named "ATCn"; any other season is excluded from all statistics (Logan).
 * Rounds inside a real season can be flagged exhibition or test on `round_overrides`
 * (getExhibitionRoundIds/getTestRoundIds in src/lib/db/rounds.ts); both are excluded via
 * getStandingsExcludedRoundIds.
 */
export function isChampionshipSeason(seasonName: string): boolean {
  return /^ATC\d+$/i.test(seasonName.trim());
}

/**
 * A championship season that is no longer `is_current`, so its titles can be awarded: no championship is
 * granted anywhere until the season is decided (Logan). Champion lists filter on this; career tallies keep
 * the current season's other stats and gate only the title count.
 */
export function isDecidedChampionshipSeason(season: Pick<Season, 'name' | 'is_current'>): boolean {
  return isChampionshipSeason(season.name) && !season.is_current;
}
