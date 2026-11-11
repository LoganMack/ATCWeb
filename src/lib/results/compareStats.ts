/**
 * The Compare view's pickable drivers, teams and cars (BR4.2-BR4.8), built in memory from one career
 * computation (BR5.1). Drivers are their career aggregate under the filter; teams and cars are credited round
 * by round from the drivers' CareerRounds, so a driver who changed team mid-season counts for each team only
 * in the rounds raced for it. The Percent denominators (races, races entered, race laps and finished seasons;
 * FR3.4-FR3.6) come from the same rounds, with no extra read.
 */
import type { CarLogo } from '../db/assets';
import type { Season } from '../db/seasons';
import { displayDriverName } from '../db/circuits';
import { resizedImageUrl } from '../db/drivers';
import { driverHref, driverPhoto, HIDDEN_DRIVER_NAME } from '../privacy';
import { hasCarPage } from '../carSpecs';
import { canonicalSeasonNumber, formatEntityKey, hiddenDriverKey, type CompareEntity } from '../compareRows';
import type { TeamBasic } from './rows';
import { isChampionshipSeason } from './shared';
import {
  aggregateCareer,
  type CareerRound,
  type DriverCareerSeasonRow,
  type DriverCareerStats,
  type TeamSeasonTitles,
} from './careerStats';
import {
  addCounts,
  countsFor,
  emptyCounts,
  filterKeepsClass,
  type ClassFilter,
  type FILTER_CLASS_NAMES,
  type StatCounts,
} from './classFilter';

export interface CompareInput {
  careers: DriverCareerStats[];
  teamTitles: TeamSeasonTitles[];
  filter: ClassFilter;
  /** The chosen season, or null for All. */
  season: Season | null;
  teams: TeamBasic[];
  carLogos: CarLogo[];
  /** Per-season team logos, the fallback for a team with no logo of its own. */
  seasonLogoRows?: { team_id: string; season_id: string; logo_url: string }[];
}

export interface CompareLists {
  /** Races the Class and Season filters cover: the Starts % denominator (FR3.4). */
  races: number;
  drivers: CompareEntity[];
  teams: CompareEntity[];
  cars: CompareEntity[];
}

interface Totals {
  starts: number;
  laps: number;
  lapsLed: number;
  counts: StatCounts;
  raceLaps: number;
  /** subsessionId -> the most starts one credited driver had in that round. */
  roundStarts: Map<number, number>;
  /** Starts from season rows with no round split, which can't be matched to a round. */
  unsplitStarts: number;
}

function newTotals(): Totals {
  return {
    starts: 0,
    laps: 0,
    lapsLed: 0,
    counts: emptyCounts(),
    raceLaps: 0,
    roundStarts: new Map(),
    unsplitStarts: 0,
  };
}

/** One driver's share of a round (or of an unsplit season row) credited to a team or car. */
interface CreditPart {
  starts: number;
  laps: number;
  lapsLed: number;
  raceLaps: number;
  /** Null for a season row with no round split. */
  subsessionId: number | null;
}

function credit(totals: Map<string, Totals>, id: string, part: CreditPart, counts: StatCounts): void {
  let t = totals.get(id);
  if (!t) {
    t = newTotals();
    totals.set(id, t);
  }
  t.starts += part.starts;
  t.laps += part.laps;
  t.lapsLed += part.lapsLed;
  // Summed per driver, unlike races entered: every ATC driver runs their own car, so each car in a round has
  // its own race laps to complete, and the sum keeps a team's Laps % its cars' own completion rate.
  t.raceLaps += part.raceLaps;
  addCounts(t.counts, counts);
  if (part.subsessionId === null) t.unsplitStarts += part.starts;
  else t.roundStarts.set(part.subsessionId, Math.max(t.roundStarts.get(part.subsessionId) ?? 0, part.starts));
}

/** Races entered: the busiest credited driver per round, so two cars in one race count it once. */
function racesEntered(t: Totals): number {
  let n = t.unsplitStarts;
  for (const starts of t.roundStarts.values()) n += starts;
  return n;
}

/** The most starts and laps any driver of one class had in one round. */
interface ClassRound {
  races: number;
  laps: number;
}

const classRoundKey = (subsessionId: number, classId: number) => `${subsessionId}:${classId}`;

/**
 * Every round's race count and lap count per class, over every driver whatever the filters (the class's own
 * leader sets its race laps, so multiclass lapping stays fair). The data has no per-race lap count, so the
 * most laps any driver of the class completed in the round stands in for the races' length.
 */
function classRounds(careers: DriverCareerStats[]): Map<string, ClassRound> {
  const out = new Map<string, ClassRound>();
  for (const career of careers) {
    for (const row of career.seasons) {
      for (const r of row.rounds) {
        const key = classRoundKey(r.subsessionId, row.classId);
        const cr = out.get(key) ?? { races: 0, laps: 0 };
        cr.races = Math.max(cr.races, r.starts);
        cr.laps = Math.max(cr.laps, r.laps);
        out.set(key, cr);
      }
    }
  }
  return out;
}

/**
 * The laps the races a driver started in one round ran (FR3.5): the class leader's laps, scaled by the
 * driver's share of the round's races so missing one race of two doesn't halve the rate. Never fewer than
 * the driver's own laps, which can happen when the round's races differ in length.
 */
function roundRaceLaps(round: CareerRound, classId: number, rounds: Map<string, ClassRound>): number {
  const cr = rounds.get(classRoundKey(round.subsessionId, classId));
  if (!cr || cr.races <= 0) return round.laps;
  return Math.max(round.laps, (cr.laps * Math.min(round.starts, cr.races)) / cr.races);
}

/** A kept season row's race laps: its rounds' sum, or its own laps when it has no round split. */
function rowRaceLaps(row: DriverCareerSeasonRow, rounds: Map<string, ClassRound>): number {
  if (row.rounds.length === 0) return row.laps;
  return row.rounds.reduce((sum, r) => sum + roundRaceLaps(r, row.classId, rounds), 0);
}

/**
 * Races the filters cover (FR3.4): per kept round, the most starts any kept driver had in it, summed. Under a
 * class filter only that class's drivers are kept, so only races the class ran count.
 */
function racesCovered(input: CompareInput): number {
  const perRound = new Map<number, number>();
  for (const career of input.careers) {
    for (const row of keptRows(career, input)) {
      for (const r of row.rounds)
        perRound.set(r.subsessionId, Math.max(perRound.get(r.subsessionId) ?? 0, r.starts));
    }
  }
  let races = 0;
  for (const n of perRound.values()) races += n;
  return races;
}

/**
 * Finished championship seasons the filters cover, for drivers (FR3.6): every finished season under Overall
 * or Combined, only the seasons the class ran under a class, narrowed to the chosen season.
 */
function driverChampionshipSeasons(input: CompareInput): number {
  const { filter } = input;
  const seasons = new Set<string>();
  if (filter.kind === 'class') {
    for (const career of input.careers) {
      for (const row of career.seasons) {
        if (row.classId === filter.classId && !row.season.is_current) seasons.add(row.season.id);
      }
    }
  } else {
    for (const t of input.teamTitles) if (!t.season.is_current) seasons.add(t.season.id);
  }
  if (input.season) return seasons.has(input.season.id) ? 1 : 0;
  return seasons.size;
}

/** Typed against the filter's class names, so renaming the class fails the type check instead of going quiet. */
const DELTA_CLASS: (typeof FILTER_CLASS_NAMES)[number] = 'Delta';

/**
 * The team competition a filter shows (BR4.7): the overall one under Overall or Combined, the Delta one under
 * Delta, none (null) under Alpha or Gamma. Shared by the titles and the finished seasons, so they never disagree.
 */
export function teamCompetition(filter: ClassFilter): 'overall' | 'delta' | null {
  if (filter.kind !== 'class') return 'overall';
  return filter.label === DELTA_CLASS ? 'delta' : null;
}

/**
 * Finished seasons the team competition the filter shows ran (FR3.6): the Delta competition's under Delta,
 * the overall competition's under Overall or Combined, none (null) under Alpha or Gamma.
 */
function teamChampionshipSeasons(input: CompareInput): number | null {
  const competition = teamCompetition(input.filter);
  if (!competition) return null;
  const seasons = new Set(
    input.teamTitles
      .filter(
        (t) =>
          !t.season.is_current &&
          (!input.season || t.season.id === input.season.id) &&
          (competition !== 'delta' || t.deltaChampionIds.length > 0),
      )
      .map((t) => t.season.id),
  );
  return seasons.size;
}

const IMAGE_WIDTH = 160;

/** The season rows a filter and season keep. */
function keptRows(career: DriverCareerStats, input: CompareInput): DriverCareerSeasonRow[] {
  return career.seasons.filter(
    (r) => filterKeepsClass(input.filter, r.classId) && (!input.season || r.season.id === input.season.id),
  );
}

/**
 * Each hidden driver's number n, over every hidden driver in a fixed server-side order (independent of the
 * filters), so the picker can tell them apart as "Hidden Driver n" under the opaque key `h:<n>`. The real id
 * never reaches the publicly cached JSON (BR4.3).
 */
function hiddenNumbers(careers: DriverCareerStats[]): Map<string, number> {
  const ids = careers
    .filter((c) => c.driver.is_hidden)
    .map((c) => c.driver.id)
    .sort();
  return new Map(ids.map((id, i) => [id, i + 1]));
}

function compareDrivers(input: CompareInput, rounds: Map<string, ClassRound>): CompareEntity[] {
  const hidden = hiddenNumbers(input.careers);
  const seasons = driverChampionshipSeasons(input);
  const out: CompareEntity[] = [];
  for (const career of input.careers) {
    const kept = keptRows(career, input);
    const agg = aggregateCareer(career.driver, kept, input.filter);
    if (agg.starts <= 0) continue;
    const d = career.driver;
    const hiddenNumber = hidden.get(d.id);
    out.push({
      key: hiddenNumber ? hiddenDriverKey(hiddenNumber) : formatEntityKey('driver', d.id),
      type: 'driver',
      name: hiddenNumber ? `${HIDDEN_DRIVER_NAME} ${hiddenNumber}` : displayDriverName(d.name),
      imageUrl: resizedImageUrl(driverPhoto(d), { width: IMAGE_WIDTH }),
      href: driverHref(d),
      starts: agg.starts,
      wins: agg.wins,
      podiums: agg.podiums,
      top5s: agg.top5s,
      top10s: agg.top10s,
      poles: agg.poles,
      laps: agg.laps,
      lapsLed: agg.lapsLed,
      championships: agg.championships,
      cornersPerIncident: agg.cornersPerIncident,
      racesEntered: agg.starts,
      raceLaps: kept.reduce((sum, row) => sum + rowRaceLaps(row, rounds), 0),
      championshipSeasons: seasons,
    });
  }
  return out;
}

/**
 * Team and car totals, credited per round (BR4.6, BR4.8). A round with no team or no car is credited to
 * neither. A season with no round split (never expected) credits its whole row to the primary team and the
 * most-raced car.
 */
function creditRounds(
  input: CompareInput,
  rounds: Map<string, ClassRound>,
): { teams: Map<string, Totals>; cars: Map<string, Totals> } {
  const teams = new Map<string, Totals>();
  const cars = new Map<string, Totals>();
  for (const career of input.careers) {
    for (const row of keptRows(career, input)) {
      if (row.rounds.length === 0) {
        const counts = countsFor(row, input.filter);
        const part = { ...row, raceLaps: row.laps, subsessionId: null };
        if (row.teams[0]) credit(teams, row.teams[0].teamId, part, counts);
        if (row.cars[0]) credit(cars, row.cars[0].carName, part, counts);
        continue;
      }
      for (const round of row.rounds) {
        const counts = countsFor(round, input.filter);
        const part = { ...round, raceLaps: roundRaceLaps(round, row.classId, rounds) };
        if (round.teamId) credit(teams, round.teamId, part, counts);
        if (round.carName) credit(cars, round.carName, part, counts);
      }
    }
  }
  return { teams, cars };
}

/** Team titles under the filter (BR4.7): overall competition, Delta competition, or none (null). */
function teamChampionships(teamId: string, input: CompareInput): number | null {
  const competition = teamCompetition(input.filter);
  if (!competition) return null;
  // Counted per season, so a season listed twice can never give a team two titles.
  const seasons = input.teamTitles
    .filter(
      (t) =>
        !t.season.is_current &&
        (!input.season || t.season.id === input.season.id) &&
        (competition === 'delta' ? t.deltaChampionIds : t.overallChampionIds).includes(teamId),
    )
    .map((t) => t.season.id);
  return new Set(seasons).size;
}

/** A team's own logo, else its newest season logo. */
function teamLogo(team: TeamBasic, input: CompareInput): string | null {
  if (team.logo_url) return team.logo_url;
  const seasonNumber = new Map(input.teamTitles.map((t) => [t.season.id, t.season.number]));
  let best: { number: number; url: string } | null = null;
  for (const row of input.seasonLogoRows ?? []) {
    if (row.team_id !== team.id) continue;
    const number = seasonNumber.get(row.season_id) ?? -1;
    if (!best || number > best.number) best = { number, url: row.logo_url };
  }
  return best?.url ?? null;
}

function entityFromTotals(
  base: Pick<
    CompareEntity,
    'key' | 'type' | 'name' | 'imageUrl' | 'href' | 'championships' | 'championshipSeasons'
  >,
  t: Totals,
): CompareEntity {
  return {
    ...base,
    starts: t.starts,
    laps: t.laps,
    lapsLed: t.lapsLed,
    ...t.counts,
    cornersPerIncident: null,
    racesEntered: racesEntered(t),
    raceLaps: t.raceLaps,
  };
}

const byName = (a: CompareEntity, b: CompareEntity) => a.name.localeCompare(b.name);

/**
 * The season a `season` address value names, by season number; anything else (absent, `all`, unknown, not a
 * championship season) is All, so the address and the edge cache key agree (BR5.2).
 */
export function resolveCompareSeason(value: string | null, seasons: Season[]): Season | null {
  const number = canonicalSeasonNumber(value);
  if (number === null) return null;
  return seasons.find((s) => s.number === number && isChampionshipSeason(s.name)) ?? null;
}

/** The query for a class filter and season, without the slot picks (Overall and All add nothing). */
export function compareQuery(filter: ClassFilter, season: Season | null): string {
  const params = new URLSearchParams();
  if (filter.addressValue !== null) params.set('class', filter.addressValue);
  if (season) params.set('season', String(season.number));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export interface CompareSeasonOption {
  label: string;
  href: string;
  selected: boolean;
}

/** All, then the championship seasons newest first, each keeping the class filter. */
export function compareSeasonOptions(
  basePath: string,
  filter: ClassFilter,
  current: Season | null,
  seasons: Season[],
): CompareSeasonOption[] {
  const championship = seasons
    .filter((s) => isChampionshipSeason(s.name))
    .sort((a, b) => b.number - a.number);
  return [
    { label: 'All', href: `${basePath}${compareQuery(filter, null)}`, selected: current === null },
    ...championship.map((s) => ({
      label: s.name,
      href: `${basePath}${compareQuery(filter, s)}`,
      selected: current?.id === s.id,
    })),
  ];
}

/**
 * The three lists for one class filter and season, each holding only entities with a start (BR4.2), and the
 * races the filters cover. All in memory from the one career computation (NFR4).
 */
export function buildCompareLists(input: CompareInput): CompareLists {
  const rounds = classRounds(input.careers);
  const credited = creditRounds(input, rounds);
  const teamById = new Map(input.teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(input.carLogos.map((c) => [c.car_name, c.logo_url]));
  const teamSeasons = teamChampionshipSeasons(input);

  const teams: CompareEntity[] = [];
  for (const [teamId, totals] of credited.teams) {
    const team = teamById.get(teamId);
    if (!team || totals.starts <= 0) continue; // a deleted team has nothing to show
    const base = {
      key: formatEntityKey('team', teamId),
      type: 'team' as const,
      name: team.name,
      imageUrl: resizedImageUrl(teamLogo(team, input), { width: IMAGE_WIDTH }),
      href: null,
      championships: teamChampionships(teamId, input),
      championshipSeasons: teamSeasons,
    };
    teams.push(entityFromTotals(base, totals));
  }

  const cars: CompareEntity[] = [];
  for (const [carName, totals] of credited.cars) {
    if (totals.starts <= 0) continue;
    const base = {
      key: formatEntityKey('car', carName),
      type: 'car' as const,
      name: carName,
      imageUrl: resizedImageUrl(carLogoByName.get(carName) ?? null, { width: IMAGE_WIDTH }),
      href: hasCarPage(carName) ? '/cars' : null,
      championships: null,
      championshipSeasons: null,
    };
    cars.push(entityFromTotals(base, totals));
  }

  return {
    races: racesCovered(input),
    drivers: compareDrivers(input, rounds).sort(byName),
    teams: teams.sort(byName),
    cars: cars.sort(byName),
  };
}
