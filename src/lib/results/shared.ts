/**
 * Season standings, champions, and race results — computed from the tables
 * an external iRacing-results import pipeline populates (curated_rounds,
 * curated_race_results, curated_qualifying) and from the scores the database
 * derives from them (race_score_results_public, filled by score_round()).
 * This file only reads them.
 *
 * Two assumptions (confirmed with Logan) are baked in throughout:
 *
 * 1. Class-relative finishing position is NOT the same as
 *    the stored overall position (`shown_position` on
 *    race_score_results_public) — that column is an OVERALL field
 *    position across every class combined. To get a driver's position
 *    within their own class (needed for wins/podiums/top 5s/top 10s), this
 *    file re-ranks each race itself, using `curated_race_results` (the raw
 *    imported results) restricted to just the drivers `race_score_results` says
 *    were in this class for that season (both `computeSeasonStandings` and
 *    `getRoundResults` below, for their per-class output, do this same
 *    re-ranking — their overall/cross-class output uses `scored_position`
 *    directly instead, since that field is already the overall position).
 *    Per race, the position used is `adjusted_position` (post-penalty) when
 *    set, falling back to `finish_position` (pre-penalty) otherwise;
 *    whenever a row actually has an `adjusted_position`, that's flagged so
 *    the UI can indicate a penalty affected the result.
 *
 * 2. Season point totals drop each driver's worst N rounds (N = the season ruleset's rules.drops.base, 2 by default), plus whatever
 *    `seasons.extra_drop_weeks` adds for that season (Logan: "the baseline
 *    amount is 2 drop weeks"). A "round" here is one subsession_id —
 *    race1+race2+race3 (when present) are summed as a single droppable
 *    unit, not dropped individually. If dropping that many rounds would
 *    leave zero counted, at least 1 round is always kept, protecting very
 *    young seasons/classes (Gamma didn't exist before ATC16, Delta before
 *    ATC5, so their early seasons have few rounds).
 *
 * Poles are read from the stored pole bonus (`shown_pole_bonus`) (only ever nonzero on a
 * round's fresh-qualifying race — races 2/3 run an inverted grid off race 1
 * and don't earn one), counted once per round (`subsession_id`), matching
 * "poles are based on appearances, not starts."
 */

import type { Season } from '../db/seasons';

/**
 * Real championship seasons are named like "ATC17" — anything that doesn't
 * match is some kind of non-points-paying/for-fun season or event (Logan:
 * "Any season of racing that doesn't follow the ATCX naming format... should
 * be excluded from all statistics"). This is intentionally name-derived
 * rather than a schema flag — no existing column captures it, and the
 * naming convention already fully determines it.
 *
 * A round *inside* an otherwise-real championship season can also be
 * individually flagged non-points — either a true exhibition or a test
 * round, both stored independently on `round_overrides` (see
 * `getExhibitionRoundIds`/`getTestRoundIds` in src/lib/supabase.ts and
 * 0005_round_overrides.sql/0036_round_test_flag.sql). Test rounds follow
 * the exact same "excluded from standings" rule exhibitions do — every
 * function below that fetches its own default exclusion set uses
 * `getStandingsExcludedRoundIds` (the union of both flags), not
 * `getExhibitionRoundIds` alone.
 */
export function isChampionshipSeason(seasonName: string): boolean {
  return /^ATC\d+$/i.test(seasonName.trim());
}

/**
 * A championship season whose results are final enough to actually hand out
 * that season's hardware from — a real championship-FORMAT season (see
 * isChampionshipSeason above) that is ALSO no longer flagged `is_current`.
 * Deliberately a separate predicate from isChampionshipSeason: that one is
 * about a season's naming/format (real vs. exhibition/test), this one is
 * about whether it's decided yet — a season can be a real ATCx championship
 * season and still be in progress. Per Logan: "we should not grant any
 * driver or team a championship in any statistic anywhere, until that
 * season is no longer marked current."
 *
 * Every place that decides "who IS the champion" (getChampions,
 * getChampionsWithExtras, getTeamChampions, computeSeasonAwards) filters its
 * season list with this instead of isChampionshipSeason alone, so the
 * in-progress season's row simply doesn't appear yet. Every place that
 * instead TALLIES a career "championships" count from a per-season
 * classPosition/teamPosition (aggregateDriverCareerStats, computeTeamCareerStats)
 * keeps including the current season's row for its other (already-final,
 * race-by-race) stats — wins, starts, laps, etc. — and only gates the
 * championship increment itself on `!row.season.is_current`, since those
 * other numbers are real regardless of how the standings race finishes.
 */
export function isDecidedChampionshipSeason(season: Pick<Season, 'name' | 'is_current'>): boolean {
  return isChampionshipSeason(season.name) && !season.is_current;
}
