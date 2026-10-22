import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds, getTestRoundIds } from '../db/rounds';
import { getSeasons } from '../db/seasons';
import { getDriverClasses } from '../db/lookups';
import type { DriverBasic } from './rows';
import { getRoundLayoutsForSubsessions } from './layoutLaps';
import { topTeamScorers } from './seasonCarTeam';
import { getMostRecentRound, getRoundsForSeason, computeDisplayRoundNumbers } from './rounds';
import { getRoundResults, type RaceResultRow } from './roundResults';
import {
  getQualifyingForSubsession,
  getPracticeForSubsession,
  type QualifyingRow,
  type PracticeRow,
} from './sessions';

/** One row in a "Previous Result" widget driver tab — same shape the homepage Standings widget's own driver rows show (position, driver, car/team logos, class badge), except `metricLabel` is whatever this SESSION's own headline figure is (race points, or a qualifying/practice lap time — see PreviousResultWidgetTab's own doc comment) rather than a season points total. `car`/`team` are null for Qualifying/Practice tabs — `curated_qualifying`/`curated_practice_results` don't carry car/team assignments the way a scored race does, so there's nothing to show a logo for there. */
export interface PreviousResultWidgetDriverRow {
  position: number | null;
  driver: DriverBasic;
  classId: number | null;
  car: { name: string; logoUrl: string | null } | null;
  team: { name: string; logoUrl: string | null } | null;
  metricLabel: string;
}

/** One row in a "Previous Result" widget TEAM tab (Race sessions only — see PreviousResultWidgetSession's own doc comment for why Practice/Qualifying never offer these). */
export interface PreviousResultWidgetTeamRow {
  position: number;
  teamName: string;
  teamLogoUrl: string | null;
  points: number;
}

export type PreviousResultWidgetTab =
  | { key: string; label: string; type: 'driver'; rows: PreviousResultWidgetDriverRow[] }
  | { key: string; label: string; type: 'team'; rows: PreviousResultWidgetTeamRow[] };

/**
 * One session within the most recent event — "Practice", "Qualifying", or a
 * single race ("Race", or "Race 1"/"Race 2"/"Race 3" for a sprint-format
 * round with more than one). Only a session that actually has results on
 * file is included at all (a round with no practice data on file just never
 * gets a "Practice" entry, same as the old classWinners-was-empty case).
 *
 * `tabs` is the same Overall/Alpha/Delta/Gamma driver-class split as the
 * homepage Standings widget, keyed and ordered the same way (`classes` in
 * the caller) — plus, for a Race session ONLY, Alpha Team/Delta Team tabs
 * (same "does this season even have a Delta Team championship"
 * `delta_team_enabled` gate the Standings widget itself uses). Practice and
 * Qualifying don't award points, so there's no meaningful "team total" to
 * rank for them — those two sessions only ever get driver tabs.
 */
export interface PreviousResultWidgetSession {
  key: string;
  label: string;
  tabs: PreviousResultWidgetTab[];
}

export interface PreviousResultWidget {
  subsessionId: number;
  seasonId: string;
  seasonLabel: string | null;
  trackName: string;
  layoutName: string | null;
  /** Null means this round is excluded from standings (exhibition/test round, or a whole non-championship season) — mirrors results.astro's own "Exhibition"/"Test" label instead of "Round N" for those. */
  displayRoundNumber: number | null;
  format: 'endurance' | 'sprint' | null;
  startTime: string;
  /** Empty (not missing) when the round genuinely has no results of any kind on file yet. */
  sessions: PreviousResultWidgetSession[];
}

/**
 * Everything the homepage's "Previous Result" card needs for the single
 * most-recently-run round on file — one Standings-widget-style tab set
 * (Overall/Alpha/Delta/Gamma, plus Alpha Team/Delta Team on Race sessions)
 * PER SESSION the round actually has results for (Practice, Qualifying,
 * each race). Penalty-adjusted wherever the round's own results page is
 * (race_score_results_public), so the two never disagree. Returns null (never throws) on any failure, or when the database
 * has no rounds on file at all yet — the homepage just omits the section in
 * either case, same as every other homepage widget's own try/catch.
 */
export async function getPreviousResultWidget(env: SupabaseEnv): Promise<PreviousResultWidget | null> {
  const round = await getMostRecentRound(env);
  if (!round) return null;

  const [
    results,
    classes,
    excludedRoundIds,
    testRoundIds,
    layoutBySubsession,
    seasonRounds,
    allSeasons,
    qualifying,
    practice,
  ] = await Promise.all([
    getRoundResults(env, round.subsession_id),
    getDriverClasses(env),
    getStandingsExcludedRoundIds(env),
    getTestRoundIds(env),
    getRoundLayoutsForSubsessions(env, [round.subsession_id]),
    getRoundsForSeason(env, round.season_id),
    getSeasons(env),
    getQualifyingForSubsession(env, round.subsession_id),
    getPracticeForSubsession(env, round.subsession_id),
  ]);

  const roundSeason = allSeasons.find((s) => s.id === round.season_id) ?? null;
  const alphaClassId = classes.find((c) => c.name === 'Alpha')?.id;
  const deltaClassId = classes.find((c) => c.name === 'Delta')?.id;

  const toDriverRow = (r: RaceResultRow): PreviousResultWidgetDriverRow => ({
    position: r.position,
    driver: r.driver,
    classId: r.classId,
    car: r.car,
    team: r.team,
    metricLabel: `${r.totalPoints} pts`,
  });
  const toQualifyingRow = (r: QualifyingRow): PreviousResultWidgetDriverRow => ({
    position: r.qualPosition,
    driver: r.driver,
    classId: r.classId,
    car: null,
    team: null,
    metricLabel: r.bestLapFormatted,
  });
  const toPracticeRow = (r: PracticeRow): PreviousResultWidgetDriverRow => ({
    position: r.position,
    driver: r.driver,
    classId: r.classId,
    car: null,
    team: null,
    metricLabel: r.bestLapFormatted,
  });

  /** Top 5, matching the homepage Standings widget's own row cap. */
  const TOP_N = 5;

  function driverTabs<T>(
    overall: T[],
    byClass: Map<number, T[]>,
    toRow: (r: T) => PreviousResultWidgetDriverRow,
  ): PreviousResultWidgetTab[] {
    return [
      { key: 'overall', label: 'Overall', type: 'driver', rows: overall.slice(0, TOP_N).map(toRow) },
      ...classes.map((c) => ({
        key: c.name,
        label: c.name,
        type: 'driver' as const,
        rows: (byClass.get(c.id) ?? []).slice(0, TOP_N).map(toRow),
      })),
    ];
  }

  /**
   * One team's total for this single race — same "only the team's top 2
   * scorers that race count" rule as the season-long team championship
   * (`topTeamScorers`), and the same class-blind points formula for Alpha
   * specifically (Alpha never earns the Class Points bonus, so its team
   * competition is scored cross-class) that `computeTeamSeasonStandings`
   * uses, just evaluated over one race's rows instead of a whole season's.
   */
  function teamTab(
    key: string,
    label: string,
    classId: number,
    classRows: RaceResultRow[],
  ): PreviousResultWidgetTab {
    const isAlpha = classId === alphaClassId;
    const pointsOf = (r: RaceResultRow) => (isAlpha ? r.totalPoints - r.classPoints : r.totalPoints);
    const rowsByTeam = new Map<string, RaceResultRow[]>();
    for (const r of classRows) {
      if (r.dsq || !r.team) continue;
      if (!rowsByTeam.has(r.team.name)) rowsByTeam.set(r.team.name, []);
      rowsByTeam.get(r.team.name)!.push(r);
    }
    const rows: Omit<PreviousResultWidgetTeamRow, 'position'>[] = [];
    for (const [teamName, teamRows] of rowsByTeam) {
      const scorers = topTeamScorers(teamRows, pointsOf);
      rows.push({
        teamName,
        teamLogoUrl: teamRows[0].team!.logoUrl,
        points: scorers.reduce((sum, r) => sum + pointsOf(r), 0),
      });
    }
    rows.sort((a, b) => b.points - a.points);
    return {
      key,
      label,
      type: 'team',
      rows: rows.slice(0, TOP_N).map((r, i) => ({ ...r, position: i + 1 })),
    };
  }

  const sessions: PreviousResultWidgetSession[] = [];

  if (practice.overall.length > 0) {
    sessions.push({
      key: 'practice',
      label: 'Practice',
      tabs: driverTabs(practice.overall, practice.byClass, toPracticeRow),
    });
  }
  if (qualifying.overall.length > 0) {
    sessions.push({
      key: 'qualifying',
      label: 'Qualifying',
      tabs: driverTabs(qualifying.overall, qualifying.byClass, toQualifyingRow),
    });
  }

  const raceNumbers = [...results.overall.keys()].sort((a, b) => a - b);
  for (const raceNumber of raceNumbers) {
    const overallRows = (results.overall.get(raceNumber) ?? []).filter((r) => !r.dsq && r.position !== null);
    const byClassForRace = new Map<number, RaceResultRow[]>();
    for (const c of classes) {
      const rows = (results.byClass.get(c.id)?.get(raceNumber) ?? []).filter(
        (r) => !r.dsq && r.position !== null,
      );
      byClassForRace.set(c.id, rows);
    }
    const tabs = driverTabs(overallRows, byClassForRace, toDriverRow);
    if (alphaClassId !== undefined) {
      tabs.push(
        teamTab(
          'alpha-team',
          'Alpha Team',
          alphaClassId,
          results.byClass.get(alphaClassId)?.get(raceNumber) ?? [],
        ),
      );
    }
    if (deltaClassId !== undefined && roundSeason?.delta_team_enabled) {
      tabs.push(
        teamTab(
          'delta-team',
          'Delta Team',
          deltaClassId,
          results.byClass.get(deltaClassId)?.get(raceNumber) ?? [],
        ),
      );
    }
    sessions.push({
      key: `race-${raceNumber}`,
      label: raceNumbers.length > 1 ? `Race ${raceNumber}` : 'Race',
      tabs,
    });
  }

  const displayRoundNumbers = computeDisplayRoundNumbers(seasonRounds, excludedRoundIds, testRoundIds);

  return {
    subsessionId: round.subsession_id,
    seasonId: round.season_id,
    seasonLabel: round.season_label,
    trackName: round.track_name,
    layoutName: layoutBySubsession.get(round.subsession_id) ?? null,
    displayRoundNumber: displayRoundNumbers.get(round.subsession_id) ?? null,
    format: round.format,
    startTime: round.start_time,
    sessions,
  };
}
