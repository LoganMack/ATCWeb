import { restGetAll, type SupabaseEnv } from '../db/client';
import type { Circuit, CircuitLayout } from '../db/circuits';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import embedReads from '../embedReads.json';
import { LEAGUE_TIME_ZONE } from '../timezone';
import { driversSelect, type RoundSummary, type DriverBasic } from './rows';
import { computeDisplayRoundNumbers } from './rounds';
import { excludedRoundIds, toEligibilityRound, type RoundEventEmbed } from './roundEligibility';

// The CI embed check (check-view-embeds.mjs) sends this same string, so a wrong FK hint fails CI.
export const PAST_RESULTS_ROUND_EVENTS_SELECT: string = embedReads.pastResultsRoundEvents.select;

/**
 * The test and exhibition rounds among `subsessionIds` (FR6.4.1): override flags or the event category, either
 * is enough. A failed read rejects so the page shows its error state rather than an unfiltered list.
 */
export async function getLayoutExcludedRoundIds(
  env: SupabaseEnv,
  subsessionIds: readonly number[],
): Promise<Set<number>> {
  if (subsessionIds.length === 0) return new Set<number>();
  const [rows, overrideIds] = await Promise.all([
    restGetAll<{ subsession_id: number } & RoundEventEmbed>(
      env,
      `curated_rounds?select=${encodeURIComponent(PAST_RESULTS_ROUND_EVENTS_SELECT)}&subsession_id=in.(${subsessionIds.join(',')})&order=subsession_id.asc`,
    ),
    getStandingsExcludedRoundIds(env),
  ]);
  const byId = new Map(rows.map((r) => [r.subsession_id, r]));
  // One pass over the input ids, so a round missing from the response still meets its override flags.
  const rounds = subsessionIds.map((id) => toEligibilityRound(byId.get(id) ?? { subsession_id: id }));
  return excludedRoundIds(rounds, overrideIds);
}

// iRacing prefixes a superseded track version with "[Retired] ", and unlike "[Legacy]" tracks those never get
// their own circuits row. Stripping the tag resolves them to the plain-named circuit; otherwise their corners
// are lost and CPI is understated.
export function normalizeTrackOrLayoutName(s: string): string {
  const withoutRetiredTag = s.replace(/^\[retired\]\s*/i, '');
  return withoutRetiredTag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves a round's track_name + layout to one circuit_layouts row, or null. A copy of newsRecap.ts's
 * matchCircuitLayout rules, because newsRecap.ts imports from here and importing back would make a cycle.
 * Exported for the results page's per-race corners-per-incident tooltip.
 */
export function resolveLayout(
  trackName: string,
  roundLayout: string | null,
  circuits: Circuit[],
  layouts: CircuitLayout[],
): CircuitLayout | null {
  const targetTrack = normalizeTrackOrLayoutName(trackName);
  const circuit = circuits.find((c) => normalizeTrackOrLayoutName(c.name) === targetTrack);
  if (!circuit) return null;
  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuit.id);
  if (circuitLayouts.length === 0) return null;
  if (circuitLayouts.length === 1) return circuitLayouts[0];
  if (!roundLayout) return null;
  const targetLayout = normalizeTrackOrLayoutName(roundLayout);
  return circuitLayouts.find((l) => normalizeTrackOrLayoutName(l.name) === targetLayout) ?? null;
}

/**
 * Every past round at one layout, newest first, for the event list's "Race Recaps at this Layout". Pure:
 * rounds and layouts are fetched once per page. The recap content is fetched lazily per round client-side
 * (api/round-recap) because computing it eagerly would exceed the subrequest limit.
 */
export interface LayoutRoundSummary {
  subsessionId: number;
  trackName: string;
  startTime: string;
  seasonLabel: string | null;
  /**
   * This round's display "Round N" (null for exhibition/test), only when the caller passes the exhibition and
   * test round ids.
   */
  displayRoundNumber: number | null;
}

/**
 * A layout for race-recap matching: a circuit_layouts row, or the circuit itself when it has no layout rows
 * (the table is optional, so many single-layout circuits have none).
 */
export type LayoutMatchKey = { kind: 'layout'; id: string } | { kind: 'circuit'; id: string };

function sameLayoutMatchKey(a: LayoutMatchKey, b: LayoutMatchKey): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function resolveEventLayoutKey(
  circuitId: string,
  eventLayoutName: string | null,
  layouts: CircuitLayout[],
): LayoutMatchKey {
  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuitId);
  if (circuitLayouts.length === 0) return { kind: 'circuit', id: circuitId };
  if (circuitLayouts.length === 1) return { kind: 'layout', id: circuitLayouts[0].id };
  if (!eventLayoutName) return { kind: 'circuit', id: circuitId };
  const targetLayout = normalizeTrackOrLayoutName(eventLayoutName);
  const match = circuitLayouts.find((l) => normalizeTrackOrLayoutName(l.name) === targetLayout);
  // A named layout that matches nothing on a circuit with layout data is ambiguous, so it stays unmatched.
  return match ? { kind: 'layout', id: match.id } : { kind: 'circuit', id: circuitId };
}

export function resolveRoundLayoutKey(
  trackName: string,
  roundLayout: string | null,
  circuits: Circuit[],
  layouts: CircuitLayout[],
): LayoutMatchKey | null {
  const targetTrack = normalizeTrackOrLayoutName(trackName);
  const circuit = circuits.find((c) => normalizeTrackOrLayoutName(c.name) === targetTrack);
  if (!circuit) return null;
  const circuitLayouts = layouts.filter((l) => l.circuit_id === circuit.id);
  if (circuitLayouts.length === 0) return { kind: 'circuit', id: circuit.id };
  if (circuitLayouts.length === 1) return { kind: 'layout', id: circuitLayouts[0].id };
  // A round with no or unknown layout falls back to the circuit-level key, so it still shows under an event
  // whose layout is equally unknown.
  if (!roundLayout) return { kind: 'circuit', id: circuit.id };
  const targetLayout = normalizeTrackOrLayoutName(roundLayout);
  const match = circuitLayouts.find((l) => normalizeTrackOrLayoutName(l.name) === targetLayout);
  return match ? { kind: 'layout', id: match.id } : { kind: 'circuit', id: circuit.id };
}

export function findRoundsForLayout(
  allRounds: RoundSummary[],
  roundLayoutBySubsession: Map<number, string | null>,
  circuits: Circuit[],
  layouts: CircuitLayout[],
  circuitId: string,
  eventLayoutName: string | null,
  /** Optional: only needed for displayRoundNumber; /api/layout-rounds.ts passes the real sets. */
  exhibitionRoundIds: Set<number> = new Set(),
  testRoundIds: Set<number> = new Set(),
): LayoutRoundSummary[] {
  const targetKey = resolveEventLayoutKey(circuitId, eventLayoutName, layouts);

  const matches = allRounds.filter((r) => {
    const resolved = resolveRoundLayoutKey(
      r.track_name,
      roundLayoutBySubsession.get(r.subsession_id) ?? null,
      circuits,
      layouts,
    );
    return resolved !== null && sameLayoutMatchKey(resolved, targetKey);
  });

  // Round numbers restart each season and depend on every round that season ran, so all rounds are grouped by
  // season first.
  const roundsBySeasonId = new Map<string, RoundSummary[]>();
  for (const r of allRounds) {
    if (!roundsBySeasonId.has(r.season_id)) roundsBySeasonId.set(r.season_id, []);
    roundsBySeasonId.get(r.season_id)!.push(r);
  }
  const displayRoundNumberBySubsession = new Map<number, number | null>();
  for (const seasonRounds of roundsBySeasonId.values()) {
    for (const [subsessionId, num] of computeDisplayRoundNumbers(
      seasonRounds,
      exhibitionRoundIds,
      testRoundIds,
    )) {
      displayRoundNumberBySubsession.set(subsessionId, num);
    }
  }

  return matches
    .sort((a, b) => b.start_time.localeCompare(a.start_time))
    .map((r) => ({
      subsessionId: r.subsession_id,
      trackName: r.track_name,
      startTime: r.start_time,
      seasonLabel: r.season_label,
      displayRoundNumber: displayRoundNumberBySubsession.get(r.subsession_id) ?? null,
    }));
}

export interface ClassHighlight {
  round: LayoutRoundSummary;
  driver: DriverBasic;
  /** Which race of the round this winner took (1, 2 or 3). Poles always report 1 — qualifying isn't split by race. */
  raceNumber: number;
  /** How many races that round ran for this class, so a caller can label "Race 2" only where a round has more than one. */
  raceCount: number;
}

export interface LayoutHighlights {
  /** classId -> that class's race-1 winners (every race's with `allRaces`) across every round in `rounds`, newest first, Race 3, 2, 1 inside a round. A round with no scored rows for a given class (it didn't run that class that weekend) simply contributes no entry for that class — never a placeholder gap. */
  winnersByClass: Map<number, ClassHighlight[]>;
  /** Same shape, for each class's pole-sitter. */
  polesByClass: Map<number, ClassHighlight[]>;
  /** The overall winner of each round (each race when all races are shown) across every class (BR3.9). */
  overallWinners: ClassHighlight[];
  /** The overall pole-sitter of each round: the lowest race-1 starting position across every class. */
  overallPoles: ClassHighlight[];
}

/** One column of the past winners and pole-sitters list. */
export interface HighlightGroup {
  key: string;
  label: string;
  winners: ClassHighlight[];
  poles: ClassHighlight[];
}

/** The "Overall" group first, then each class with any entry, in `classes` order (BR3.9). */
export function layoutHighlightGroups(
  h: LayoutHighlights,
  classes: { id: number; name: string }[],
): HighlightGroup[] {
  const groups: HighlightGroup[] = [];
  if (h.overallWinners.length > 0 || h.overallPoles.length > 0) {
    groups.push({ key: 'overall', label: 'Overall', winners: h.overallWinners, poles: h.overallPoles });
  }
  for (const c of classes) {
    const winners = h.winnersByClass.get(c.id) ?? [];
    const poles = h.polesByClass.get(c.id) ?? [];
    if (winners.length > 0 || poles.length > 0)
      groups.push({ key: String(c.id), label: c.name, winners, poles });
  }
  return groups;
}

export function emptyLayoutHighlights(): LayoutHighlights {
  return { winnersByClass: new Map(), polesByClass: new Map(), overallWinners: [], overallPoles: [] };
}

export interface RaceOneScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  shown_position: number | null;
  classified: boolean;
  dsq: boolean;
}

export interface RaceOneCuratedRow {
  subsession_id: number;
  cust_id: number;
  starting_position: number | null;
}

/**
 * Per-class race-1 winner and pole for each given round, for the Event Briefing's past winners list, in two
 * bulk queries. Winner is the lowest shown, non-DSQ position (penalties applied); pole is the lowest starting
 * position, not `pole_bonus`, which Alpha never earns.
 */
export async function getLayoutClassHighlights(
  env: SupabaseEnv,
  rounds: LayoutRoundSummary[],
  driversBasic?: DriverBasic[],
  /** When true, winners are every race's winner (a sprint weekend gives one per race) instead of race 1 only. Poles are unaffected either way. */
  options: { allRaces?: boolean } = {},
): Promise<LayoutHighlights> {
  const allRaces = options.allRaces === true;
  if (rounds.length === 0) return emptyLayoutHighlights();

  const subsessionIds = rounds.map((r) => r.subsessionId);
  const [drivers, scoreRows, curatedRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env, { includeAi: true }),
    restGetAll<RaceOneScoreRow>(
      env,
      `race_score_results_public?select=subsession_id,race_number,driver_id,class_id,shown_position,classified,dsq&subsession_id=in.(${subsessionIds.join(',')})${allRaces ? '' : '&race_number=eq.1'}`,
    ),
    restGetAll<RaceOneCuratedRow>(
      env,
      `curated_race_results_shown?select=subsession_id,cust_id,starting_position&subsession_id=in.(${subsessionIds.join(',')})&race_number=eq.1`,
    ),
  ]);
  return buildLayoutHighlights(rounds, drivers, scoreRows, curatedRows, allRaces);
}

/**
 * The highlights from rows already read (pure). Class winners and poles as before; the overall entries take
 * the same rows across every class, so a round with no classified rows gets no overall winner (BR3.9).
 */
export function buildLayoutHighlights(
  rounds: LayoutRoundSummary[],
  drivers: DriverBasic[],
  scoreRows: RaceOneScoreRow[],
  curatedRows: RaceOneCuratedRow[],
  allRaces: boolean,
): LayoutHighlights {
  const winnersByClass = new Map<number, ClassHighlight[]>();
  const polesByClass = new Map<number, ClassHighlight[]>();
  const roundBySubsession = new Map(rounds.map((r) => [r.subsessionId, r]));
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const driverByCustId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.iracing_cust_id as number, d]),
  );

  const winnerBySubClass = new Map<string, { driverId: string; position: number }>();
  const classIdBySubDriver = new Map<string, number>();
  // Distinct race numbers per (subsession, class), for the "Race N" label.
  const raceNumbersBySubClass = new Map<string, Set<number>>();
  for (const s of scoreRows) {
    classIdBySubDriver.set(`${s.subsession_id}:${s.driver_id}`, s.class_id);
    const classKey = `${s.subsession_id}:${s.class_id}`;
    if (!raceNumbersBySubClass.has(classKey)) raceNumbersBySubClass.set(classKey, new Set());
    raceNumbersBySubClass.get(classKey)!.add(s.race_number);
    if (!s.classified || s.dsq || s.shown_position === null) continue;
    const key = allRaces ? `${s.subsession_id}:${s.class_id}:${s.race_number}` : classKey;
    const existing = winnerBySubClass.get(key);
    if (!existing || s.shown_position < existing.position) {
      winnerBySubClass.set(key, { driverId: s.driver_id, position: s.shown_position });
    }
  }

  const poleBySubClass = new Map<string, { custId: number; position: number }>();
  for (const c of curatedRows) {
    if (c.starting_position === null) continue;
    const driver = driverByCustId.get(c.cust_id);
    if (!driver) continue;
    const classId = classIdBySubDriver.get(`${c.subsession_id}:${driver.id}`);
    if (classId === undefined) continue;
    const key = `${c.subsession_id}:${classId}`;
    const existing = poleBySubClass.get(key);
    if (!existing || c.starting_position < existing.position) {
      poleBySubClass.set(key, { custId: c.cust_id, position: c.starting_position });
    }
  }

  for (const [key, { driverId }] of winnerBySubClass) {
    const [subsessionIdStr, classIdStr, raceNumberStr] = key.split(':');
    const round = roundBySubsession.get(Number(subsessionIdStr));
    const driver = driverById.get(driverId);
    if (!round || !driver) continue;
    const classId = Number(classIdStr);
    if (!winnersByClass.has(classId)) winnersByClass.set(classId, []);
    winnersByClass.get(classId)!.push({
      round,
      driver,
      raceNumber: raceNumberStr ? Number(raceNumberStr) : 1,
      raceCount: raceNumbersBySubClass.get(`${subsessionIdStr}:${classIdStr}`)?.size ?? 1,
    });
  }

  for (const [key, { custId }] of poleBySubClass) {
    const [subsessionIdStr, classIdStr] = key.split(':');
    const round = roundBySubsession.get(Number(subsessionIdStr));
    const driver = driverByCustId.get(custId);
    if (!round || !driver) continue;
    const classId = Number(classIdStr);
    if (!polesByClass.has(classId)) polesByClass.set(classId, []);
    polesByClass.get(classId)!.push({ round, driver, raceNumber: 1, raceCount: 1 });
  }

  // Newest round first, the higher subsession id on a tie, then Race 3, 2, 1 inside a round (BR8.2).
  const byRoundDesc = (a: ClassHighlight, b: ClassHighlight) =>
    b.round.startTime.localeCompare(a.round.startTime) ||
    b.round.subsessionId - a.round.subsessionId ||
    b.raceNumber - a.raceNumber;
  for (const list of winnersByClass.values()) list.sort(byRoundDesc);
  for (const list of polesByClass.values()) list.sort(byRoundDesc);

  const overallWinners = overallWinnerHighlights(scoreRows, roundBySubsession, driverById, allRaces);
  // A round with no classified rows gets no overall entry at all (BR3.9), pole included.
  const roundsWithWinner = new Set(overallWinners.map((w) => w.round.subsessionId));
  const overallPoles: ClassHighlight[] = [];
  const overallPoleBySub = new Map<number, { custId: number; position: number }>();
  for (const c of curatedRows) {
    if (c.starting_position === null || !roundsWithWinner.has(c.subsession_id)) continue;
    const driver = driverByCustId.get(c.cust_id);
    // Same gate as a class pole: the driver must have scored in the round.
    if (!driver || !classIdBySubDriver.has(`${c.subsession_id}:${driver.id}`)) continue;
    const existing = overallPoleBySub.get(c.subsession_id);
    if (!existing || c.starting_position < existing.position) {
      overallPoleBySub.set(c.subsession_id, { custId: c.cust_id, position: c.starting_position });
    }
  }
  for (const [subsessionId, { custId }] of overallPoleBySub) {
    const round = roundBySubsession.get(subsessionId);
    const driver = driverByCustId.get(custId);
    if (round && driver) overallPoles.push({ round, driver, raceNumber: 1, raceCount: 1 });
  }
  overallWinners.sort(byRoundDesc);
  overallPoles.sort(byRoundDesc);

  return { winnersByClass, polesByClass, overallWinners, overallPoles };
}

/**
 * The highlights without the rounds in `excluded` (test and exhibition rounds, BR8.5), as a new object. One
 * set lookup per entry, so the cost grows with the entries and never with the excluded set.
 */
export function withoutExcludedRounds(h: LayoutHighlights, excluded: ReadonlySet<number>): LayoutHighlights {
  const keep = (entry: ClassHighlight) => !excluded.has(entry.round.subsessionId);
  const winnersByClass = new Map<number, ClassHighlight[]>();
  for (const [classId, list] of h.winnersByClass) winnersByClass.set(classId, list.filter(keep));
  const polesByClass = new Map<number, ClassHighlight[]>();
  for (const [classId, list] of h.polesByClass) polesByClass.set(classId, list.filter(keep));
  return {
    winnersByClass,
    polesByClass,
    overallWinners: h.overallWinners.filter(keep),
    overallPoles: h.overallPoles.filter(keep),
  };
}

/** Rows (past rounds or incidents) without those of an excluded round, order kept. */
export function withoutExcludedRoundRows<T extends { subsessionId: number }>(
  rows: readonly T[],
  excluded: ReadonlySet<number>,
): T[] {
  return rows.filter((row) => !excluded.has(row.subsessionId));
}

const PAST_RESULT_DATE_OPTIONS = { month: 'short', day: '2-digit', year: 'numeric' } as const;
const leagueDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: LEAGUE_TIME_ZONE,
  ...PAST_RESULT_DATE_OPTIONS,
});
const utcDateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...PAST_RESULT_DATE_OPTIONS });

/**
 * "Nov 03, 2026" on the league's calendar day (BR8.1). A bare YYYY-MM-DD is already a calendar day, so it is
 * read at UTC noon and never shifts; the em dash stands in for a missing or bad date, as the pages did.
 */
export function formatPastResultDate(dateInput: string | null): string {
  if (!dateInput) return '—';
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (dayOnly) {
    const [, y, m, d] = dayOnly;
    return utcDateFormat.format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12)));
  }
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '—';
  return leagueDateFormat.format(date);
}

/** The lowest shown position across every class per round (or per race), classified and not DSQ only. */
function overallWinnerHighlights(
  scoreRows: RaceOneScoreRow[],
  roundBySubsession: Map<number, LayoutRoundSummary>,
  driverById: Map<string, DriverBasic>,
  allRaces: boolean,
): ClassHighlight[] {
  const raceNumbersBySub = new Map<number, Set<number>>();
  const winnerByKey = new Map<string, { driverId: string; position: number; raceNumber: number }>();
  for (const s of scoreRows) {
    if (!raceNumbersBySub.has(s.subsession_id)) raceNumbersBySub.set(s.subsession_id, new Set());
    raceNumbersBySub.get(s.subsession_id)!.add(s.race_number);
    if (!s.classified || s.dsq || s.shown_position === null) continue;
    const key = allRaces ? `${s.subsession_id}:${s.race_number}` : String(s.subsession_id);
    const existing = winnerByKey.get(key);
    if (!existing || s.shown_position < existing.position) {
      winnerByKey.set(key, { driverId: s.driver_id, position: s.shown_position, raceNumber: s.race_number });
    }
  }
  const out: ClassHighlight[] = [];
  for (const [key, w] of winnerByKey) {
    const subsessionId = Number(key.split(':')[0]);
    const round = roundBySubsession.get(subsessionId);
    const driver = driverById.get(w.driverId);
    if (!round || !driver) continue;
    out.push({
      round,
      driver,
      raceNumber: allRaces ? w.raceNumber : 1,
      raceCount: raceNumbersBySub.get(subsessionId)?.size ?? 1,
    });
  }
  return out;
}
