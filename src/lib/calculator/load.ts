/**
 * Loads one season and championship for the points calculator (BR3.1, BR3.2, BR3.12, BR3.13; FR2.1, FR2.6,
 * NFR1, NFR2). Driver championships take the Standings page's own rows: the stored round stats through the
 * adapter, with the live per-race builders only when the stored rows are incomplete. Team championships take
 * the season's scored rows, because the top-two re-pick needs each member's points per race. The calendar's
 * remaining rounds come from the season's championship events. Names come only from the masked driver list.
 * Server-only.
 */
import type { SupabaseEnv } from '../db/client';
import { getSeasonCalendarEvents } from '../db/events';
import { getDriverClasses, type Lookup } from '../db/lookups';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getScoringRulesets, getSeasons, resolveSeasonRuleset, type ScoringRuleset, type Season } from '../db/seasons';
import { canonicalSeasonNumber } from '../compareRows';
import { classStandingsFromRounds, loadStoredSeasons, overallStandingsFromRounds } from '../results/roundStatsAdapter';
import { getRoundsForSeason } from '../results/rounds';
import {
  driversSelect,
  getRaceScoresForSeasonOverall,
  getTeamsBasic,
  type DriverBasic,
  type RoundSummary,
} from '../results/rows';
import { isChampionshipSeason } from '../results/shared';
import { computeOverallSeasonStandings, computeSeasonStandings } from '../results/standings';
import { MIN_ROUNDS_FOR_DROPS, seasonDropWeeks, type DriverSeasonStanding } from '../results/standingsCore';
import {
  assembleSeason,
  buildCalendar,
  buildRounds,
  driverEntrants,
  teamEntrants,
  type RunRoundInput,
} from './build';
import { CHAMPIONSHIPS, isTeamChampionship, type CalculatorSeason, type Championship } from './types';

/** The championship seasons, newest first (the Season filter's list). */
export function calculatorSeasons(seasons: readonly Season[]): Season[] {
  return seasons.filter((s) => isChampionshipSeason(s.name)).sort((a, b) => b.number - a.number);
}

/** BR3.13: the season asked for, else the current season, else the newest championship season. */
export function resolveCalculatorSeason(value: string | null, seasons: readonly Season[]): Season | null {
  const list = calculatorSeasons(seasons);
  const number = canonicalSeasonNumber(value);
  return (
    (number !== null ? list.find((s) => s.number === number) : undefined) ??
    list.find((s) => s.is_current) ??
    list[0] ??
    null
  );
}

/** The championships a season ran (Gamma, Delta and Delta Team only when the season enables them). */
export function availableChampionships(season: Pick<Season, 'gamma_enabled' | 'delta_enabled' | 'delta_team_enabled'>): Championship[] {
  return CHAMPIONSHIPS.filter((c) => {
    if (c === 'gamma') return season.gamma_enabled;
    if (c === 'delta') return season.delta_enabled;
    if (c === 'delta_team') return season.delta_team_enabled;
    return true;
  });
}

/** BR3.13: an unknown or unavailable championship is Overall. */
export function resolveChampionship(value: string | null, season: Season | null): Championship {
  const available = season ? availableChampionships(season) : ['overall'];
  return (available as readonly string[]).includes(value ?? '') ? (value as Championship) : 'overall';
}

const CLASS_OF: Partial<Record<Championship, string>> = { alpha: 'Alpha', gamma: 'Gamma', delta: 'Delta' };

interface Refs {
  drivers: DriverBasic[];
  classes: Lookup[];
  rulesets: ScoringRuleset[];
  excludedIds: Set<number>;
}

/** The Standings page's rows for a driver championship: stored first, live only as the fallback. */
async function driverStandings(
  env: SupabaseEnv,
  season: Season,
  championship: Championship,
  refs: Refs,
): Promise<DriverSeasonStanding[]> {
  const className = CLASS_OF[championship];
  const classId = className ? refs.classes.find((c) => c.name === className)?.id : undefined;
  if (className && classId === undefined) return [];
  const load = await loadStoredSeasons(env, [season], refs.excludedIds, {
    teamCompetitions: [],
    penaltyPoints: false,
  });
  const stats = load.stats.get(season.id);
  if (stats) {
    const standingsRefs = { drivers: refs.drivers, rulesets: refs.rulesets, classes: refs.classes };
    return classId !== undefined
      ? classStandingsFromRounds(stats, classId, standingsRefs)
      : overallStandingsFromRounds(stats, standingsRefs);
  }
  return classId !== undefined
    ? computeSeasonStandings(
        env,
        season,
        classId,
        refs.drivers,
        refs.excludedIds,
        refs.classes,
        undefined,
        undefined,
        refs.rulesets,
      )
    : computeOverallSeasonStandings(env, season, refs.drivers, refs.excludedIds, undefined, refs.rulesets);
}

/** The run rounds a championship's pool holds, with their race counts, in RunRoundInput form. */
function runRoundsFrom(
  seasonRounds: readonly RoundSummary[],
  racesBySubsession: ReadonlyMap<number, number>,
): RunRoundInput[] {
  return seasonRounds
    .filter((r) => racesBySubsession.has(r.subsession_id))
    .map((r) => ({
      subsessionId: r.subsession_id,
      startTime: r.start_time,
      trackName: r.track_name,
      format: r.format,
      roundNumber: r.round_number,
      races: racesBySubsession.get(r.subsession_id) ?? 1,
    }));
}

/** Races per round from the standings rows: the most starts any driver made in it. */
export function racesFromStandings(standings: readonly DriverSeasonStanding[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of standings) {
    for (const id of s.roundCells.keys()) {
      const starts = s.roundStats.get(id)?.starts ?? 1;
      out.set(id, Math.max(out.get(id) ?? 0, starts, 1));
    }
  }
  return out;
}

export interface CalculatorLoad {
  data: CalculatorSeason;
  season: Season;
  championship: Championship;
}

/**
 * One season and championship for the calculator, or null when no championship season exists. Throws when a
 * read fails, so the fragment shows its load error (FR8.4).
 */
export async function loadCalculatorSeason(
  env: SupabaseEnv,
  seasonParam: string | null,
  championshipParam: string | null,
): Promise<CalculatorLoad | null> {
  const [seasons, rulesets, classes, excludedIds, drivers] = await Promise.all([
    getSeasons(env),
    getScoringRulesets(env),
    getDriverClasses(env),
    getStandingsExcludedRoundIds(env),
    driversSelect(env),
  ]);
  const season = resolveCalculatorSeason(seasonParam, seasons);
  if (!season) return null;
  const championship = resolveChampionship(championshipParam, season);
  const ruleset = resolveSeasonRuleset(season, rulesets);
  const refs: Refs = { drivers, classes, rulesets, excludedIds };

  const [events, seasonRounds] = await Promise.all([
    getSeasonCalendarEvents(env, season.id),
    getRoundsForSeason(env, season.id),
  ]);
  const rounds = seasonRounds.filter((r) => !excludedIds.has(r.subsession_id));

  if (isTeamChampionship(championship)) {
    const [scoresRaw, teams] = await Promise.all([getRaceScoresForSeasonOverall(env, season.id), getTeamsBasic(env)]);
    const scores = scoresRaw.filter((s) => !excludedIds.has(s.subsession_id));
    const racesBySubsession = new Map<number, number>();
    for (const s of scores) {
      racesBySubsession.set(s.subsession_id, Math.max(racesBySubsession.get(s.subsession_id) ?? 1, s.race_number));
    }
    const slots = buildCalendar(runRoundsFrom(rounds, racesBySubsession), events);
    const calcRounds = buildRounds(slots, ruleset?.rules, championship);
    const deltaClassId = classes.find((c) => c.name === 'Delta')?.id ?? null;
    return {
      season,
      championship,
      data: assembleSeason({
        season,
        championship,
        rounds: calcRounds,
        entrants: teamEntrants(championship, scores, slots, calcRounds, { drivers, teams, deltaClassId }),
        dropCount: 0,
        dropsFromRounds: MIN_ROUNDS_FOR_DROPS,
        canDropFinalRound: true,
      }),
    };
  }

  const standings = await driverStandings(env, season, championship, refs);
  const slots = buildCalendar(runRoundsFrom(rounds, racesFromStandings(standings)), events);
  const calcRounds = buildRounds(slots, ruleset?.rules, championship);
  return {
    season,
    championship,
    data: assembleSeason({
      season,
      championship,
      rounds: calcRounds,
      entrants: driverEntrants(standings, calcRounds, slots),
      dropCount: seasonDropWeeks(season, rulesets),
      dropsFromRounds: MIN_ROUNDS_FOR_DROPS,
      // Protected (false) when no ruleset resolves, as the Standings page does.
      canDropFinalRound: ruleset?.can_drop_final_round ?? false,
    }),
  };
}
