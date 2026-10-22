import { restGetAll, type SupabaseEnv } from '../db/client';
import type { Circuit, CircuitLayout } from '../db/circuits';
import { driversSelect, type RoundSummary, type DriverBasic } from './rows';
import { computeDisplayRoundNumbers } from './rounds';

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
  /** classId -> that class's race-1 winners across every round in `rounds`, newest first. A round with no scored rows for a given class (it didn't run that class that weekend) simply contributes no entry for that class — never a placeholder gap. */
  winnersByClass: Map<number, ClassHighlight[]>;
  /** Same shape, for each class's pole-sitter. */
  polesByClass: Map<number, ClassHighlight[]>;
}

interface RaceOneScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  shown_position: number | null;
  classified: boolean;
  dsq: boolean;
}

interface RaceOneCuratedRow {
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
  const winnersByClass = new Map<number, ClassHighlight[]>();
  const polesByClass = new Map<number, ClassHighlight[]>();
  if (rounds.length === 0) return { winnersByClass, polesByClass };

  const subsessionIds = rounds.map((r) => r.subsessionId);
  const roundBySubsession = new Map(rounds.map((r) => [r.subsessionId, r]));

  const [drivers, scoreRows, curatedRows] = await Promise.all([
    driversBasic ? Promise.resolve(driversBasic) : driversSelect(env, { includeAi: true }),
    restGetAll<RaceOneScoreRow>(
      env,
      `race_score_results_public?select=subsession_id,race_number,driver_id,class_id,shown_position,classified,dsq&subsession_id=in.(${subsessionIds.join(',')})${allRaces ? '' : '&race_number=eq.1'}`,
    ),
    restGetAll<RaceOneCuratedRow>(
      env,
      `curated_race_results?select=subsession_id,cust_id,starting_position&subsession_id=in.(${subsessionIds.join(',')})&race_number=eq.1`,
    ),
  ]);

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

  // Newest round first; within a round, race 1 before race 2 before race 3.
  const byRoundDesc = (a: ClassHighlight, b: ClassHighlight) =>
    b.round.startTime.localeCompare(a.round.startTime) || a.raceNumber - b.raceNumber;
  for (const list of winnersByClass.values()) list.sort(byRoundDesc);
  for (const list of polesByClass.values()) list.sort(byRoundDesc);

  return { winnersByClass, polesByClass };
}
