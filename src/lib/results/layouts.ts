import { restGetAll, type SupabaseEnv } from '../db/client';
import type { Circuit, CircuitLayout } from '../db/circuits';
import { driversSelect, type RoundSummary, type DriverBasic } from './rows';
import { computeDisplayRoundNumbers } from './rounds';

// iRacing tags a track's older, superseded configuration with a leading
// "[Retired] " on track_name (e.g. "[Retired] Barber Motorsports Park") once
// it ships an updated version under the plain name. Unlike "[Legacy] ..."
// tracks (which get their OWN circuits row here, since those really are a
// materially different old layout with its own corner count — e.g.
// "[Legacy] Phoenix Raceway - 2008"), nobody has ever added a separate
// circuits row for the "[Retired]" tracks — there's just the one row under
// the plain name. Left un-stripped, every "[Retired] X" round silently
// failed to resolve to any circuit at all: not just this round's own
// corners-per-incident tooltip, but every season/career stat that sums
// corners across rounds (see DriverSeasonExtendedStats.totalCorners) still
// counted that round's incidents in the denominator while contributing
// nothing to the numerator, quietly dragging down CPI for anyone who raced
// one of these rounds. Stripping the tag before normalizing resolves them
// to the same circuit the plain name already matches — confirmed against
// this repo's own circuits data that no "[Retired]"-tagged name has ever
// been entered as its own distinct row, so this can't collide with one.
export function normalizeTrackOrLayoutName(s: string): string {
  const withoutRetiredTag = s.replace(/^\[retired\]\s*/i, '');
  return withoutRetiredTag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves a round's `track_name` + `curated_rounds.layout` column to one
 * `circuit_layouts` row — a minimal, standalone re-derivation of
 * newsRecap.ts's own `matchCircuitLayout` (same direct/normalized matching
 * rules; see that function's doc comment for the full reasoning). Duplicated
 * rather than imported because newsRecap.ts already imports FROM this file
 * (getRoundBySubsessionId, getRoundResults, topTeamScorers) — importing back
 * the other way would create a cycle. This version only needs the resolved
 * row (not newsRecap's admin-facing "issue" text), so it just returns null
 * on anything it can't resolve to exactly one layout. Callers pull whichever
 * field they need off the result (length_km for distance driven, corners for
 * corners-per-incident) — one shared resolution since the matching logic is
 * identical either way.
 *
 * Exported so /results/[subsessionId].astro can resolve just this one
 * round's layout (for ResultsTable's per-race corners-per-incident tooltip)
 * without pulling in the season-wide extended-stats machinery this file's
 * other callers use it from.
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
 * Every historical round ever run at one specific circuit_layouts row,
 * newest first — powers the event list's "Race Recaps at this Layout"
 * collapsible (src/components/EventDetailCard.astro). Pure/no network calls
 * itself: `allRounds` and `roundLayoutBySubsession` are meant to be fetched
 * ONCE per page (getAllRounds() + getRoundLayoutsForSubsessions()) and reused
 * across every event card, same "bulk fetch once, slice in memory per card"
 * reasoning as computeDriverCareerStats — a calendar can show many events
 * that repeat the same circuit, so per-card fetches would multiply query
 * count by the number of cards shown.
 *
 * The recap CONTENT (top finishers, fastest lap, etc.) is deliberately NOT
 * computed here — that's the expensive part (computeRoundRecap, ~8 queries
 * per round), and running it eagerly for every matching round on every card
 * could blow through Cloudflare Workers' subrequest limit on a calendar with
 * any history at all (see README's homepage-widget incident for this exact
 * class of bug). Callers fetch each round's recap lazily, client-side, only
 * once a visitor expands it — see
 * src/pages/api/round-recap/[subsessionId].ts and src/scripts/roundRecap.ts.
 */
export interface LayoutRoundSummary {
  subsessionId: number;
  trackName: string;
  startTime: string;
  seasonLabel: string | null;
  /**
   * This round's app-computed "Round N" (see computeDisplayRoundNumbers'
   * own doc comment) — null for an exhibition/test/non-championship round,
   * same meaning as everywhere else this display numbering is used. Only
   * populated when a caller passes real exhibitionRoundIds/testRoundIds
   * into findRoundsForLayout (see its own doc comment) — a caller that
   * doesn't care about this (e.g. one that only reads trackName/startTime)
   * can omit those and this just comes back null for every round, same as
   * before this field existed.
   */
  displayRoundNumber: number | null;
}

/**
 * A round or event's layout, for race-recap matching purposes only — either
 * a real circuit_layouts row (when one can be pinned down) or, when a
 * circuit has NO circuit_layouts rows at all, the circuit itself stands in
 * for "the one implicit layout everyone races there." circuit_layouts is an
 * OPTIONAL table (see the Circuits CSV import's own `writesTo` doc comment
 * — it only gets a row when someone attaches layout-specific details, e.g.
 * a logo or disambiguating a multi-layout track), so plenty of single-layout
 * circuits never get one. `resolveLayout` (above), used for a round's
 * length_km/corners, correctly treats a missing row as "nothing to match."
 * The race-recap feature used to share that same logic, which made "Race
 * Recaps at this Layout" silently come up empty for every event at a
 * circuit missing that optional row, even with real round history. This
 * type/pair of functions lets findRoundsForLayout fall back to matching on
 * the circuit alone in that case — as precise as the site can be without
 * layout data on file to disambiguate.
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
  // A named-but-unmatched layout on a circuit that DOES have layout data on
  // file is a real ambiguity (which of the other layouts is this?) — stays
  // unmatched rather than falling back to "any layout at this circuit,"
  // unlike the two branches above where there's no layout data to be
  // ambiguous WITH in the first place.
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
  // A round with no layout on file, or one that doesn't match any known
  // layout name, used to return null here — dropping the round out of
  // findRoundsForLayout's matches ENTIRELY, for every event at that
  // circuit, rather than just failing to pin it to one specific layout.
  // That silently hid "Race Recaps at this Layout" history any time a
  // multi-layout circuit had a round with curated_rounds.layout left
  // unset (exactly the class of gap the 0023 migration backfilled for 92
  // rounds) — and would recur for any future round an admin forgets to
  // fill in. Falling back to the circuit-level key instead mirrors
  // resolveEventLayoutKey's own fallback just above: the round still
  // won't claim to be a SPECIFIC layout it can't confirm, but it's no
  // longer invisible outright — it'll surface under an event whose own
  // layout is equally unset/ambiguous (the only case that resolves to a
  // circuit-level key on the event side too).
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
  /**
   * Optional — only needed to populate each result's displayRoundNumber
   * (see LayoutRoundSummary's own doc comment). Defaulted to empty Sets so
   * every existing caller that doesn't care about round numbers (the Event
   * Briefing page, as of this writing) keeps working unchanged; a caller
   * that DOES want them (the calendar page's "Race Recaps at this Layout"
   * feature, via /api/layout-rounds.ts) passes the real
   * getExhibitionRoundIds()/getTestRoundIds() results through.
   */
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

  // Display round numbers are SEASON-scoped (every season restarts at 1),
  // so this groups the FULL allRounds list (not just this layout's own
  // matches — a season's numbering depends on every round it ran, not only
  // the ones that happen to match this one layout) by season_id and runs
  // computeDisplayRoundNumbers per season, same function results.astro
  // already calls for one season at a time — just applied across every
  // season at once here, since one layout's history can span many of them.
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
  /** classId -> that class's race-1 winners across every round in `rounds`, newest first. A round with no race_scores rows for a given class (it didn't run that class that weekend) simply contributes no entry for that class — never a placeholder gap. */
  winnersByClass: Map<number, ClassHighlight[]>;
  /** Same shape, for each class's pole-sitter. */
  polesByClass: Map<number, ClassHighlight[]>;
}

interface RaceOneScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  scored_position: number | null;
  classified: boolean;
  dsq: boolean;
}

interface RaceOneCuratedRow {
  subsession_id: number;
  cust_id: number;
  starting_position: number | null;
}

/**
 * Per-class winner and pole-sitter for every round in `rounds` — powers the
 * Event Briefing page's "past winners and polesitters for each class" list
 * (src/pages/briefing/[eventId].astro). `rounds` is expected to be
 * findRoundsForLayout()'s output for one circuit+layout, but this function
 * itself is layout-agnostic — it just computes highlights for whichever
 * rounds it's given, in two bulk queries total (not one pair per round),
 * same "resolve everything for the whole set at once" approach as
 * getCuratedRaceResultsWithLapStatsBulk/getPenaltiesForSubsessions.
 *
 * Both "winner" and "pole" are scoped to race 1 only — the only race with
 * real qualifying (2/3 grids invert off it) and, per site convention, the
 * one every other race-1-only stat in this file (e.g.
 * computeOverallPoleDriverBySubsession) already anchors to.
 *
 * Winner = the classified, non-DSQ'd race_scores row with the lowest
 * `scored_position` within that (subsession, class) — scored_position
 * already reflects any post-race penalty reclassification, the same source
 * of truth every other finishing-order figure on the site uses. Pole = the
 * lowest `curated_race_results.starting_position` within that (subsession,
 * class) — deliberately NOT `race_scores.pole_bonus` (that's Gamma/Delta's
 * "Class Pole" BONUS; Alpha never earns it at all — see
 * computeOverallPoleDriverBySubsession's own doc comment — so it can't stand
 * in as a real pole-sitter for every class uniformly).
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
      `race_scores_public?select=subsession_id,race_number,driver_id,class_id,scored_position,classified,dsq&subsession_id=in.(${subsessionIds.join(',')})${allRaces ? '' : '&race_number=eq.1'}`,
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
    if (!s.classified || s.dsq || s.scored_position === null) continue;
    const key = allRaces ? `${s.subsession_id}:${s.class_id}:${s.race_number}` : classKey;
    const existing = winnerBySubClass.get(key);
    if (!existing || s.scored_position < existing.position) {
      winnerBySubClass.set(key, { driverId: s.driver_id, position: s.scored_position });
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
