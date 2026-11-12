/**
 * Stats > Seasons rows (FR5; BR5.1-BR5.5): one row per championship season for the chosen class, from the
 * season's counted rounds and their race summaries (season_race_summaries). Pure: the fragment does the reads
 * (seasonStatsLoad.ts).
 */
import type { EventWetFlags } from '../db/events';
import { LEAGUE_TIME_ZONE } from '../timezone';
import { formatDuration } from './raceCard';
import type { RaceSummaryRow, SummaryScope } from './seasonRaceSummaries';
import { isChampionshipSeason } from './shared';

export const SEASON_STATS_SCOPES: readonly SummaryScope[] = ['overall', 'alpha', 'gamma', 'delta'];

/**
 * The `?class=` value as a scope; anything else falls back to Overall (BR5.4). Exact values only, so the edge
 * cache, which keeps only these values in its key (src/lib/edgeCache.ts), never stores a class render under the
 * Overall key.
 */
export function parseSeasonStatsScope(value: string | null | undefined): SummaryScope {
  return (SEASON_STATS_SCOPES as readonly (string | null | undefined)[]).includes(value)
    ? (value as SummaryScope)
    : 'overall';
}

export interface SeasonStatsSeason {
  id: string;
  number: number;
  name: string;
  logo_url: string | null;
  logo_url_light: string | null;
}

export interface SeasonStatsRound {
  subsession_id: number;
  season_id: string;
  start_time: string;
  strength_of_field: number | null;
  num_drivers: number | null;
  event_id: string | null;
}

export interface SeasonStatsRow {
  seasonId: string;
  seasonNumber: number;
  seasonName: string;
  logoUrl: string | null;
  logoUrlLight: string | null;
  /** League-local calendar dates, 'YYYY-MM-DD'. */
  startDate: string;
  endDate: string;
  days: number;
  totalRaceTimeTenThousandths: number | null;
  rounds: number;
  races: number;
  uniqueWinners: number;
  avgSof: number | null;
  avgGridSize: number | null;
  avgCpi: number | null;
  wetRaces: number;
}

export interface SeasonStatsInput {
  seasons: SeasonStatsSeason[];
  rounds: SeasonStatsRound[];
  /** Exhibition- and test-flagged round ids; never counted. */
  excludedRoundIds: Set<number>;
  summaries: RaceSummaryRow[];
  events: EventWetFlags[];
  /** Each round's layout corner count (resolveLayout); missing or null when unknown. */
  cornersByRound: Map<number, number | null>;
  scope: SummaryScope;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LEAGUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A round's start as its league-local (America/New_York) calendar date, 'YYYY-MM-DD' (BR5.2). */
export function leagueDate(startTime: string): string {
  return dayFormatter.format(new Date(startTime));
}

/** Calendar days from start to end, counting both days (BR5.2). */
export function daysInclusive(startDate: string, endDate: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(endDate) - toUtc(startDate)) / 86_400_000) + 1;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' as "Mar 04, 2026" (FR5.6). */
export function formatSeasonDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The round's event: event_id when set, else the event pinned by events.subsession_id (BR3.7). */
function eventResolver(events: EventWetFlags[]) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const bySubsession = new Map<number, EventWetFlags>();
  for (const e of events) if (e.subsession_id !== null) bySubsession.set(Number(e.subsession_id), e);
  return (round: SeasonStatsRound) =>
    (round.event_id ? byId.get(round.event_id) : undefined) ?? bySubsession.get(round.subsession_id) ?? null;
}

function isWetRace(event: EventWetFlags | null, raceNumber: number): boolean {
  if (!event) return false;
  const flags = event as unknown as Record<string, unknown>;
  return flags[`race${raceNumber}_wet_affected`] === true;
}

/** Race CPI (BR5.3): corners driven (laps x the layout's corners) per incident; null when either is unknown. */
export function raceCpi(row: RaceSummaryRow, corners: number | null | undefined): number | null {
  if (
    !corners ||
    corners <= 0 ||
    row.laps_total === null ||
    !row.incidents_total ||
    row.incidents_total <= 0
  ) {
    return null;
  }
  return (row.laps_total * corners) / row.incidents_total;
}

/** The Grid Size of one counted round in the chosen scope (BR3.4, BR5.4); null when nobody is counted. */
function roundGrid(round: SeasonStatsRound, scopeRows: RaceSummaryRow[], scope: SummaryScope): number | null {
  if (scope === 'overall' && round.num_drivers !== null && round.num_drivers > 0) return round.num_drivers;
  const counted = Math.max(0, ...scopeRows.map((r) => r.round_drivers));
  return counted > 0 ? counted : null;
}

function buildRow(
  season: SeasonStatsSeason,
  counted: SeasonStatsRound[],
  rowsByRound: Map<number, RaceSummaryRow[]>,
  input: SeasonStatsInput,
  findEvent: (round: SeasonStatsRound) => EventWetFlags | null,
): SeasonStatsRow | null {
  const { scope } = input;
  const overallRows = counted.flatMap((r) =>
    (rowsByRound.get(r.subsession_id) ?? []).filter((s) => s.scope === 'overall'),
  );
  const scopeRows = counted.flatMap((r) =>
    (rowsByRound.get(r.subsession_id) ?? []).filter((s) => s.scope === scope),
  );
  if (scopeRows.length === 0) return null;

  const dates = counted.map((r) => leagueDate(r.start_time)).sort();
  const raceTimes = overallRows
    .map((r) => r.race_time_ten_thousandths)
    .filter((t): t is number => t !== null);
  const winners = new Set(scopeRows.map((r) => r.winner_driver_id).filter((id): id is string => !!id));
  const sofs = counted.map((r) => r.strength_of_field).filter((s): s is number => s !== null && s > 0);
  const grids = counted
    .map((round) => {
      const rows = (rowsByRound.get(round.subsession_id) ?? []).filter((s) => s.scope === scope);
      return rows.length > 0 ? roundGrid(round, rows, scope) : null;
    })
    .filter((g): g is number => g !== null);
  const cpis = counted.flatMap((round) =>
    (rowsByRound.get(round.subsession_id) ?? [])
      .filter((s) => s.scope === scope)
      .map((s) => raceCpi(s, input.cornersByRound.get(round.subsession_id)))
      .filter((c): c is number => c !== null),
  );
  const wetRaces = counted.reduce((sum, round) => {
    const event = findEvent(round);
    const races = (rowsByRound.get(round.subsession_id) ?? []).filter((s) => s.scope === 'overall');
    return sum + races.filter((s) => isWetRace(event, s.race_number)).length;
  }, 0);

  return {
    seasonId: season.id,
    seasonNumber: season.number,
    seasonName: season.name,
    logoUrl: season.logo_url,
    logoUrlLight: season.logo_url_light,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    days: daysInclusive(dates[0], dates[dates.length - 1]),
    totalRaceTimeTenThousandths: raceTimes.length > 0 ? raceTimes.reduce((a, b) => a + b, 0) : null,
    rounds: counted.length,
    races: overallRows.length,
    uniqueWinners: winners.size,
    avgSof: mean(sofs),
    avgGridSize: mean(grids),
    avgCpi: mean(cpis),
    wetRaces,
  };
}

/**
 * One row per championship season with a counted round (BR5.1), newest first (BR5.5). A counted round belongs
 * to the season, is not exhibition- or test-flagged, and has an overall race summary. With a class chosen,
 * seasons where that class did not run are left out (BR5.4).
 */
export function computeSeasonStats(input: SeasonStatsInput): SeasonStatsRow[] {
  const rowsByRound = new Map<number, RaceSummaryRow[]>();
  for (const row of input.summaries) {
    const id = Number(row.subsession_id);
    if (!rowsByRound.has(id)) rowsByRound.set(id, []);
    rowsByRound.get(id)!.push(row);
  }
  const findEvent = eventResolver(input.events);
  const out: SeasonStatsRow[] = [];
  for (const season of input.seasons) {
    if (!isChampionshipSeason(season.name)) continue;
    const counted = input.rounds.filter(
      (r) =>
        r.season_id === season.id &&
        !input.excludedRoundIds.has(r.subsession_id) &&
        (rowsByRound.get(r.subsession_id) ?? []).some((s) => s.scope === 'overall'),
    );
    if (counted.length === 0) continue;
    const row = buildRow(season, counted, rowsByRound, input, findEvent);
    if (row) out.push(row);
  }
  return out.sort((a, b) => b.seasonNumber - a.seasonNumber);
}

/** One table cell: its text and its sort value; '—' cells sort as missing (BR5.5). */
export interface SeasonStatsCell {
  text: string;
  sortValue: string | number | null;
}

function numberCell(value: number | null, digits: number): SeasonStatsCell {
  return value === null ? { text: '—', sortValue: null } : { text: value.toFixed(digits), sortValue: value };
}

/** The row's display cells, keyed by column. */
export function seasonStatsCells(row: SeasonStatsRow): Record<string, SeasonStatsCell> {
  return {
    start: { text: formatSeasonDate(row.startDate), sortValue: row.startDate },
    end: { text: formatSeasonDate(row.endDate), sortValue: row.endDate },
    days: { text: String(row.days), sortValue: row.days },
    raceTime: {
      text: formatDuration(row.totalRaceTimeTenThousandths),
      sortValue: row.totalRaceTimeTenThousandths,
    },
    rounds: { text: String(row.rounds), sortValue: row.rounds },
    races: { text: String(row.races), sortValue: row.races },
    winners: { text: String(row.uniqueWinners), sortValue: row.uniqueWinners },
    sof: numberCell(row.avgSof === null ? null : Math.round(row.avgSof), 0),
    grid: numberCell(row.avgGridSize, 1),
    cpi: numberCell(row.avgCpi, 1),
    wet: { text: String(row.wetRaces), sortValue: row.wetRaces },
  };
}
