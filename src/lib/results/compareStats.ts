/**
 * The Compare view's pickable drivers, teams and cars (BR4.2-BR4.8), built in memory from one career
 * computation (BR5.1). Drivers are their career aggregate under the filter; teams and cars are credited round
 * by round from the drivers' CareerRounds, so a driver who changed team mid-season counts for each team only
 * in the rounds raced for it.
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
  drivers: CompareEntity[];
  teams: CompareEntity[];
  cars: CompareEntity[];
}

interface Totals {
  starts: number;
  laps: number;
  lapsLed: number;
  counts: StatCounts;
}

function newTotals(): Totals {
  return { starts: 0, laps: 0, lapsLed: 0, counts: emptyCounts() };
}

function credit(
  totals: Map<string, Totals>,
  id: string,
  part: { starts: number; laps: number; lapsLed: number },
  counts: StatCounts,
): void {
  let t = totals.get(id);
  if (!t) {
    t = newTotals();
    totals.set(id, t);
  }
  t.starts += part.starts;
  t.laps += part.laps;
  t.lapsLed += part.lapsLed;
  addCounts(t.counts, counts);
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

function compareDrivers(input: CompareInput): CompareEntity[] {
  const hidden = hiddenNumbers(input.careers);
  const out: CompareEntity[] = [];
  for (const career of input.careers) {
    const agg = aggregateCareer(career.driver, keptRows(career, input), input.filter);
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
    });
  }
  return out;
}

/**
 * Team and car totals, credited per round (BR4.6, BR4.8). A round with no team or no car is credited to
 * neither. A season with no round split (never expected) credits its whole row to the primary team and the
 * most-raced car.
 */
function creditRounds(input: CompareInput): { teams: Map<string, Totals>; cars: Map<string, Totals> } {
  const teams = new Map<string, Totals>();
  const cars = new Map<string, Totals>();
  for (const career of input.careers) {
    for (const row of keptRows(career, input)) {
      if (row.rounds.length === 0) {
        const counts = countsFor(row, input.filter);
        if (row.teams[0]) credit(teams, row.teams[0].teamId, row, counts);
        if (row.cars[0]) credit(cars, row.cars[0].carName, row, counts);
        continue;
      }
      for (const round of row.rounds) {
        const counts = countsFor(round, input.filter);
        if (round.teamId) credit(teams, round.teamId, round, counts);
        if (round.carName) credit(cars, round.carName, round, counts);
      }
    }
  }
  return { teams, cars };
}

/** Team titles under the filter (BR4.7): overall competition, Delta competition, or none (null). */
function teamChampionships(teamId: string, input: CompareInput): number | null {
  const { filter } = input;
  const useDelta = filter.kind === 'class' && filter.label === 'Delta';
  if (filter.kind === 'class' && !useDelta) return null;
  // Counted per season, so a season listed twice can never give a team two titles.
  const seasons = input.teamTitles
    .filter(
      (t) =>
        !t.season.is_current &&
        (!input.season || t.season.id === input.season.id) &&
        (useDelta ? t.deltaChampionIds : t.overallChampionIds).includes(teamId),
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
  base: Pick<CompareEntity, 'key' | 'type' | 'name' | 'imageUrl' | 'href' | 'championships'>,
  t: Totals,
): CompareEntity {
  return {
    ...base,
    starts: t.starts,
    laps: t.laps,
    lapsLed: t.lapsLed,
    ...t.counts,
    cornersPerIncident: null,
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
    { label: 'All seasons', href: `${basePath}${compareQuery(filter, null)}`, selected: current === null },
    ...championship.map((s) => ({
      label: s.name,
      href: `${basePath}${compareQuery(filter, s)}`,
      selected: current?.id === s.id,
    })),
  ];
}

/** The three lists for one class filter and season, each holding only entities with a start (BR4.2). */
export function buildCompareLists(input: CompareInput): CompareLists {
  const credited = creditRounds(input);
  const teamById = new Map(input.teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(input.carLogos.map((c) => [c.car_name, c.logo_url]));

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
    };
    cars.push(entityFromTotals(base, totals));
  }

  return {
    drivers: compareDrivers(input).sort(byName),
    teams: teams.sort(byName),
    cars: cars.sort(byName),
  };
}
