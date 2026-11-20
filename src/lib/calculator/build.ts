/**
 * Builds the points calculator's CalculatorSeason from data already read (BR3.1, BR3.2, BR3.4, BR3.5, BR3.12):
 * the calendar from the run rounds and the season's championship events, the rounds' points tables and caps
 * from the ruleset, driver entrants from the Standings page's own standings rows and team entrants from the
 * scored rows. Pure, so the golden parity test feeds it captured data; src/lib/calculator/load.ts does the
 * reads. Names and keys come from the masked driver list only: a hidden driver is "Hidden Driver" with an
 * opaque key, never their id.
 */
import type { SeasonCalendarEvent } from '../db/events';
import { displayDriverName } from '../db/circuits';
import type { DriverBasic, RacePointsRow, ScoreRow, TeamBasic } from '../results/rows';
import type { DriverSeasonStanding } from '../results/standingsCore';
import { teamRoundTotal } from './engine';
import { isOverrideRound, roundCaps, type PointsBasis } from './rulesetPoints';
import {
  CHAMPIONSHIP_LABELS,
  isTeamChampionship,
  type CalculatorEntrant,
  type CalculatorMember,
  type CalculatorRound,
  type CalculatorSeason,
  type Championship,
  type Tiebreak,
} from './types';

/** A run round of the season, as the calendar needs it. */
export interface RunRoundInput {
  subsessionId: number;
  startTime: string;
  trackName: string | null;
  format: 'sprint' | 'endurance' | null;
  /** The pipeline's round number, matched against an event's round_number. */
  roundNumber: number | null;
  /** Races run in the round (1-3). */
  races: number;
}

/** One calendar slot before pricing. */
export interface CalendarSlot {
  subsessionId: number | null;
  format: 'sprint' | 'endurance' | 'special';
  races: number;
  track: string | null;
}

/** Order for a round with no subsession id yet: after every run round, in calendar order. */
const FUTURE_ORDER_BASE = 1e12;

function eventRaces(event: SeasonCalendarEvent): number {
  const slots = [
    event.race1_start_time ?? event.race1_laps,
    event.race2_start_time ?? event.race2_laps,
    event.race3_start_time ?? event.race3_laps,
  ];
  return Math.max(1, slots.filter((v) => v !== null && v !== undefined).length);
}

/**
 * The season's calendar: every run round in start-time order, then each championship event that matches no
 * run round and falls after the latest one (a remaining round, FR2.6). An unmatched event dated before the
 * latest run round was not run (cancelled or never imported) and is left out.
 */
export function buildCalendar(
  runRounds: readonly RunRoundInput[],
  events: readonly SeasonCalendarEvent[],
): CalendarSlot[] {
  const run = [...runRounds].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.subsessionId - b.subsessionId,
  );
  const matched = new Set<string>();
  const slots: CalendarSlot[] = run.map((r) => {
    const event =
      events.find((e) => e.subsession_id === r.subsessionId) ??
      events.find((e) => e.round_number !== null && e.round_number === r.roundNumber && !matched.has(e.id));
    if (event) matched.add(event.id);
    const eventFormat = event && event.format !== 'special' ? event.format : null;
    return {
      subsessionId: r.subsessionId,
      format: r.format ?? eventFormat ?? 'endurance',
      races: Math.max(1, r.races),
      track: r.trackName ?? event?.circuits?.name ?? null,
    };
  });
  const lastRunDate = run.length ? run[run.length - 1].startTime.slice(0, 10) : '';
  for (const e of events) {
    if (matched.has(e.id) || e.event_date <= lastRunDate) continue;
    slots.push({
      subsessionId: null,
      format: e.format,
      races: e.format === 'special' ? 1 : eventRaces(e),
      track: e.circuits?.name ?? null,
    });
  }
  return slots;
}

/** Which class's podium points a championship counts (BR3.1). */
export function pointsBasis(championship: Championship): PointsBasis {
  if (championship === 'gamma') return { className: 'Gamma' };
  if (championship === 'delta' || championship === 'delta_team') return { className: 'Delta' };
  return { className: null };
}

/** The calendar priced from the ruleset (BR3.4, BR3.5, BR3.8). */
export function buildRounds(
  slots: readonly CalendarSlot[],
  rules: unknown,
  championship: Championship,
): CalculatorRound[] {
  const team = isTeamChampionship(championship);
  const basis = pointsBasis(championship);
  const lastScoring = slots.reduce((last, s, i) => (s.format === 'special' ? last : i), -1);
  return slots.map((slot, i): CalculatorRound => {
    const short = `R${i + 1}`;
    const base = {
      index: i + 1,
      label: slot.track ? `${short} · ${slot.track}` : short,
      short,
      order: slot.subsessionId ?? FUTURE_ORDER_BASE + i,
      races: slot.races,
      isFinal: i === lastScoring,
    };
    if (slot.format === 'special') {
      return {
        ...base,
        state: 'special',
        format: 'special',
        tables: [],
        bestCase: 0,
        secondPlaceCase: 0,
        soloBestCase: 0,
        soloSecondPlaceCase: 0,
      };
    }
    const caps = roundCaps(rules, slot.format, slot.races, basis, isOverrideRound(rules, slot.subsessionId));
    return {
      ...base,
      state: slot.subsessionId === null ? 'future' : 'completed',
      format: slot.format,
      tables: caps.races,
      bestCase: team ? caps.teamBestCase : caps.bestCase,
      secondPlaceCase: team ? caps.teamSecondPlaceCase : caps.secondPlaceCase,
      soloBestCase: caps.bestCase,
      soloSecondPlaceCase: caps.secondPlaceCase,
    };
  });
}

/** The key and name a driver may be shown with: a hidden driver gets the stand-in key, never their id. */
export function maskedIdentity(
  driver: DriverBasic | undefined,
  fallbackKey: string,
): { key: string; name: string } {
  if (!driver) return { key: fallbackKey, name: 'Unknown driver' };
  if (driver.is_hidden) {
    const stand = driver.iracing_cust_id;
    return { key: stand === null ? `h-${fallbackKey}` : `h${Math.abs(stand)}`, name: 'Hidden Driver' };
  }
  return { key: driver.id, name: displayDriverName(driver.name) };
}

const NO_TIEBREAK: Tiebreak = {
  wins: 0,
  podiums: 0,
  top5s: 0,
  top10s: 0,
  poles: 0,
  lapsLed: 0,
  laps: 0,
  appearances: 0,
};

/** A driver's points per race of the season, by driver id then subsession id (race number - 1 indexed). */
export type RaceBreakdown = Map<string, Map<number, (number | null)[]>>;

/**
 * The per-race points of a driver championship from the scored rows: overall totals for Overall, the class's
 * class totals for a class championship (BR3.1).
 */
export function raceBreakdown(
  rows: readonly RacePointsRow[],
  championship: Championship,
  classId: number | null,
): RaceBreakdown {
  const out: RaceBreakdown = new Map();
  for (const row of rows) {
    if (classId !== null && row.class_id !== classId) continue;
    let byRound = out.get(row.driver_id);
    if (!byRound) out.set(row.driver_id, (byRound = new Map()));
    const races = byRound.get(row.subsession_id) ?? [];
    races[row.race_number - 1] = championship === 'overall' ? row.overall_total : row.class_total;
    byRound.set(row.subsession_id, races);
  }
  return out;
}

/** A round's races padded to its race count, kept only when they add up to the round's points. */
function racesFor(
  races: (number | null)[] | undefined,
  raceCount: number,
  points: number | null,
): (number | null)[] | null {
  if (!races || points === null) return null;
  const padded = Array.from({ length: Math.max(raceCount, races.length) }, (_, r) => races[r] ?? null);
  const sum = padded.reduce<number>((s, p) => s + (p ?? 0), 0);
  return Math.abs(sum - points) < 0.001 ? padded : null;
}

/** Driver entrants from the Standings page's rows (live points, tiebreak counts as loaded; BR3.1, BR3.3). */
export function driverEntrants(
  standings: readonly DriverSeasonStanding[],
  rounds: readonly CalculatorRound[],
  slots: readonly CalendarSlot[],
  breakdown?: RaceBreakdown,
): CalculatorEntrant[] {
  return standings.map((s, i) => {
    const { key, name } = maskedIdentity(s.driver, `d${i + 1}`);
    const roundPoints = rounds.map((_, r) => {
      const id = slots[r].subsessionId;
      return id === null ? null : (s.roundCells.get(id)?.points ?? null);
    });
    const driverRaces = s.driver ? breakdown?.get(s.driver.id) : undefined;
    return {
      key,
      name,
      roundPoints,
      ...(breakdown
        ? {
            racePoints: rounds.map((round, r) => {
              const id = slots[r].subsessionId;
              return id === null ? null : racesFor(driverRaces?.get(id), round.races, roundPoints[r]);
            }),
          }
        : {}),
      tiebreak: {
        wins: s.wins,
        podiums: s.podiums,
        top5s: s.top5s,
        top10s: s.top10s,
        poles: s.poles,
        lapsLed: s.lapsLed,
        laps: s.laps,
        appearances: s.appearances,
      },
    };
  });
}

/**
 * Team entrants from the scored rows (BR3.1): Alpha Team counts every class's overall totals, Delta Team only
 * Delta drivers' class totals; per race the top two members count. Teams rank on points, then name.
 */
export function teamEntrants(
  championship: Championship,
  scores: readonly ScoreRow[],
  slots: readonly CalendarSlot[],
  rounds: readonly CalculatorRound[],
  refs: { drivers: readonly DriverBasic[]; teams: readonly TeamBasic[]; deltaClassId: number | null },
): CalculatorEntrant[] {
  const slotBySubsession = new Map<number, number>();
  slots.forEach((s, i) => {
    if (s.subsessionId !== null) slotBySubsession.set(s.subsessionId, i);
  });
  const delta = championship === 'delta_team';
  const pointsOf = (row: ScoreRow) => (delta ? row.class_total : row.overall_total);
  const driverById = new Map(refs.drivers.map((d) => [d.id, d]));

  const byTeam = new Map<string, Map<string, ((number | null)[] | null)[]>>();
  for (const row of scores) {
    if (!row.team_id) continue;
    if (delta && row.class_id !== refs.deltaClassId) continue;
    const slot = slotBySubsession.get(row.subsession_id);
    if (slot === undefined) continue;
    let members = byTeam.get(row.team_id);
    if (!members) byTeam.set(row.team_id, (members = new Map()));
    let races = members.get(row.driver_id);
    if (!races) members.set(row.driver_id, (races = rounds.map(() => null)));
    const round = races[slot] ?? Array.from({ length: rounds[slot].races }, () => null);
    round[row.race_number - 1] = pointsOf(row);
    races[slot] = round;
  }

  const entrants: CalculatorEntrant[] = [];
  for (const team of refs.teams) {
    const members = byTeam.get(team.id);
    if (!members) continue;
    const list: CalculatorMember[] = [...members].map(([driverId, racePoints], i) => ({
      ...maskedIdentity(driverById.get(driverId), `${team.id}-m${i + 1}`),
      racePoints,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    entrants.push({
      key: team.id,
      name: team.name,
      roundPoints: rounds.map((round, r) =>
        teamRoundTotal(
          list.map((m) => m.racePoints[r]),
          round.races,
        ),
      ),
      tiebreak: NO_TIEBREAK,
      members: list,
    });
  }
  return entrants;
}

/** The finished CalculatorSeason. */
export function assembleSeason(input: {
  season: { id: string; name: string };
  championship: Championship;
  rounds: CalculatorRound[];
  entrants: CalculatorEntrant[];
  dropCount: number;
  dropsFromRounds: number;
  canDropFinalRound: boolean;
}): CalculatorSeason {
  const isTeam = isTeamChampionship(input.championship);
  return {
    seasonId: input.season.id,
    seasonName: input.season.name,
    championship: input.championship,
    championshipLabel: CHAMPIONSHIP_LABELS[input.championship],
    isTeam,
    rounds: input.rounds,
    entrants: input.entrants,
    dropCount: isTeam ? 0 : input.dropCount,
    dropsFromRounds: input.dropsFromRounds,
    canDropFinalRound: input.canDropFinalRound,
  };
}
