import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds, getTestRoundIds } from '../db/rounds';
import { getSeasons } from '../db/seasons';
import { getDriverClasses, type Lookup } from '../db/lookups';
import type { DriverBasic } from './rows';
import { getRoundLayoutsForSubsessions } from './layoutLaps';
import { topTeamScorers } from './seasonCarTeam';
import { getMostRecentRound, getRoundsForSeason, computeDisplayRoundNumbers } from './rounds';
import { getRoundResults, type RaceResultRow, type RoundResults } from './roundResults';
import {
  getQualifyingForSubsession,
  getPracticeForSubsession,
  type QualifyingRow,
  type PracticeRow,
} from './sessions';

/** One row in a "Previous Result" widget driver tab — same shape the homepage Standings widget's own driver rows show (position, driver, car/team logos, class badge), except `metricLabel` is whatever this SESSION's own headline figure is (race points, or a qualifying/practice lap time — see PreviousResultWidgetTab's own doc comment) rather than a season points total. Qualifying and Practice carry no car or team of their own, so their rows take the driver's car and team from the round's first race (`firstRaceCarTeam`); null when the driver did not race in it. */
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
 * One session of the latest event with results (Practice, Qualifying or a race). Tabs follow the homepage
 * Standings widget; Alpha/Delta Team tabs appear on races only, since practice and qualifying award no
 * points.
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

/** Top 5, matching the homepage Standings widget's own row cap. */
const TOP_N = 5;

type CarTeam = Pick<PreviousResultWidgetDriverRow, 'car' | 'team'>;

/**
 * Each driver's car and team from their row in the round's first race (the lowest race number with rows),
 * for the Qualifying and Practice tabs. A driver missing from that race has no entry.
 */
export function firstRaceCarTeam(overall: Map<number, RaceResultRow[]>): Map<string, CarTeam> {
  const out = new Map<string, CarTeam>();
  const firstRace = Math.min(...[...overall.keys()].filter((n) => (overall.get(n)?.length ?? 0) > 0));
  for (const r of overall.get(firstRace) ?? []) {
    if (!out.has(r.driver.id)) out.set(r.driver.id, { car: r.car, team: r.team });
  }
  return out;
}

/**
 * One race's team tab rows: each team's top 2 rows by `pointsOf`, summed, best five teams. Disqualified rows
 * and rows with no team are left out; a team with one eligible row scores that row. Ties go to the better best
 * row, then the better best class position (rows carry class positions), then the team name, as the Race
 * Results winner (race_winners_for_rounds) breaks them.
 */
export function teamTabRows(
  rows: RaceResultRow[],
  pointsOf: (r: RaceResultRow) => number,
): PreviousResultWidgetTeamRow[] {
  const rowsByTeam = new Map<string, RaceResultRow[]>();
  for (const r of rows) {
    if (r.dsq || !r.team) continue;
    if (!rowsByTeam.has(r.team.name)) rowsByTeam.set(r.team.name, []);
    rowsByTeam.get(r.team.name)!.push(r);
  }
  const teams: (Omit<PreviousResultWidgetTeamRow, 'position'> & { bestRow: number; bestPosition: number })[] =
    [];
  for (const [teamName, teamRows] of rowsByTeam) {
    const scorers = topTeamScorers(teamRows, pointsOf);
    const positions = scorers.map((r) => r.position).filter((p): p is number => p !== null);
    teams.push({
      teamName,
      teamLogoUrl: teamRows[0].team!.logoUrl,
      points: scorers.reduce((sum, r) => sum + pointsOf(r), 0),
      bestRow: Math.max(...scorers.map(pointsOf)),
      bestPosition: positions.length > 0 ? Math.min(...positions) : Infinity,
    });
  }
  teams.sort(
    (a, b) =>
      b.points - a.points ||
      b.bestRow - a.bestRow ||
      a.bestPosition - b.bestPosition ||
      (a.teamName < b.teamName ? -1 : a.teamName > b.teamName ? 1 : 0),
  );
  return teams
    .slice(0, TOP_N)
    .map(({ teamName, teamLogoUrl, points }, i) => ({ position: i + 1, teamName, teamLogoUrl, points }));
}

/**
 * One race's Alpha Team tab: the overall, every-class team competition. Every class's rows count, each by
 * points without class points.
 */
export function alphaTeamRows(
  byClass: RoundResults['byClass'],
  classes: Pick<Lookup, 'id'>[],
  raceNumber: number,
): PreviousResultWidgetTeamRow[] {
  const rows = classes.flatMap((c) => byClass.get(c.id)?.get(raceNumber) ?? []);
  return teamTabRows(rows, (r) => r.totalPoints - r.classPoints);
}

/** One race's Delta Team tab: Delta rows by class total. */
export function deltaTeamRows(
  byClass: RoundResults['byClass'],
  deltaClassId: number,
  raceNumber: number,
): PreviousResultWidgetTeamRow[] {
  return teamTabRows(byClass.get(deltaClassId)?.get(raceNumber) ?? [], (r) => r.totalPoints);
}

/**
 * The homepage "Previous Result" card for the latest round: a tab set per session with results,
 * penalty-adjusted like the results page. Null on failure or with no rounds; the homepage omits the card.
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
  const deltaClassId = classes.find((c) => c.name === 'Delta')?.id;

  const toDriverRow = (r: RaceResultRow): PreviousResultWidgetDriverRow => ({
    position: r.position,
    driver: r.driver,
    classId: r.classId,
    car: r.car,
    team: r.team,
    metricLabel: `${r.totalPoints} pts`,
  });
  const raceOneCarTeam = firstRaceCarTeam(results.overall);
  const carTeamOf = (driverId: string): CarTeam => raceOneCarTeam.get(driverId) ?? { car: null, team: null };
  const toQualifyingRow = (r: QualifyingRow): PreviousResultWidgetDriverRow => ({
    position: r.qualPosition,
    driver: r.driver,
    classId: r.classId,
    ...carTeamOf(r.driver.id),
    metricLabel: r.bestLapFormatted,
  });
  const toPracticeRow = (r: PracticeRow): PreviousResultWidgetDriverRow => ({
    position: r.position,
    driver: r.driver,
    classId: r.classId,
    ...carTeamOf(r.driver.id),
    metricLabel: r.bestLapFormatted,
  });

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
    tabs.push({
      key: 'alpha-team',
      label: 'Alpha Team',
      type: 'team',
      rows: alphaTeamRows(results.byClass, classes, raceNumber),
    });
    if (deltaClassId !== undefined && roundSeason?.delta_team_enabled) {
      tabs.push({
        key: 'delta-team',
        label: 'Delta Team',
        type: 'team',
        rows: deltaTeamRows(results.byClass, deltaClassId, raceNumber),
      });
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
