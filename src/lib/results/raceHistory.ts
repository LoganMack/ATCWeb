import { restGet, restGetAll, type SupabaseEnv } from '../db/client';
import { getExhibitionRoundIds, getTestRoundIds } from '../db/rounds';
import { getCarLogos } from '../db/assets';
import { getSeasons, getScoringRulesets, resolveSeasonRuleset, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions } from '../db/penalties';
import { getDriverClasses } from '../db/lookups';
import { getCircuits, getAllCircuitLayouts, type Circuit, type CircuitLayout } from '../db/circuits';
import { computeSeasonOverallAdjustments, type SeasonScoreRow } from '../penalties/seasonAdjustments';
import {
  getCuratedRaceResultsForSubsessions,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  getRaceScoresForSubsessionsOverall,
  getLapStatsForSubsessions,
  driversSelect,
  getQualifyingForSubsessionsBulk,
  resultKey,
  buildSeasonLogoMap,
  resolveTeamLogo,
  type CuratedQualifyingBulkRow,
  type RoundSummary,
} from './rows';
import { resolveLayout } from './layouts';
import { getRoundLayoutsForSubsessions } from './layoutLaps';
import { getAllRounds, computeDisplayRoundNumbers } from './rounds';
import { formatMargin } from './format';

// ---------------------------------------------------------------------------
// Driver race history — every individual race (not season-aggregated) a
// driver has ever run, powering the driver profile page's race-by-race
// table (src/pages/drivers/[id].astro). Deliberately a much simpler
// computation than computeDriverCareerStats above: that function re-derives
// class-relative standings positions across every driver in a season
// (needed for wins/podiums/etc.); this one only needs THIS ONE driver's own
// race_scores + curated_race_results rows, so it never touches the
// standings engine at all.
// ---------------------------------------------------------------------------

export interface DriverRaceHistoryRow {
  subsessionId: number;
  raceNumber: number;
  /** Null only if this round's curated_rounds row is somehow missing despite having race_scores (shouldn't normally happen). */
  season: Season | null;
  trackName: string;
  /** trackName plus this round's specific circuit_layouts configuration (curated_rounds.layout — e.g. "Autodromo Nazionale Monza — Junior" vs plain "Autodromo Nazionale Monza" when a track has only one configuration or the round's layout column is unset). Distinct from trackName alone: many tracks run several materially different configurations (oval vs road course, "Grand Prix" vs "National", etc.) under the exact same track_name — see resolveLayout's own doc comment. Used by the Splits card's Layout split so those don't get lumped into one row. */
  layoutLabel: string;
  /** ISO timestamp — raw curated_rounds.start_time, for sorting/formatting by the caller. Empty string under the same "missing round row" condition as `season`. */
  startTime: string;
  /** This app's own "Round N" numbering (see computeDisplayRoundNumbers) — null for an exhibition/test round or a non-championship season. */
  displayRoundNumber: number | null;
  classId: number;
  className: string;
  car: { name: string; logoUrl: string | null } | null;
  /** The team this driver raced for in this specific race (race_scores.team_id) — same historical-logo resolution as RaceResultRow.team. */
  team: { name: string; logoUrl: string | null } | null;
  /** Raw OVERALL grid position (every class combined) — see classStartingPosition for this driver's position within their own class that race. */
  startingPosition: number | null;
  /** Post-penalty position from the live penalty-adjustment engine (computeSeasonOverallAdjustments — the same one every other page uses, recomputed from the CURRENT penalties table) when it repositions this race, falling back to the legacy curated_race_results.adjusted_position manual override, then to the raw finish_position — same fallback chain as RaceResultRow. An unclassified (NC/DSQ) row is never repositioned by the engine (canReposition requires classified === true), so it naturally falls through to the legacy/raw value. This is the OVERALL field position (every class combined) — see classPosition for this driver's position within their own class that race, which is what "wins"/"podiums"/etc. should always be judged against for a non-Alpha driver. */
  finishPosition: number;
  /**
   * This driver's position within their OWN class that race — re-derived
   * from curated_race_results restricted to the other drivers race_scores
   * says shared their class that race, exactly like computeSeasonStandings/
   * getRoundResults already do for their own per-class views (see this
   * file's header comment: "Class-relative finishing position is NOT the
   * same as race_scores.scored_position"). Ranked off `adjusted_position ??
   * finish_position` (DSQ'd drivers excluded from ranking, same as
   * computeSeasonStandings) — unlike `finishPosition` above, this does NOT
   * re-run the live per-class penalty cascade (computeSeasonClassAdjustments
   * is season/class-scoped and not practical to replay for one driver's
   * whole cross-season career here), so on the rare race where a penalty
   * actually reordered this class, this can lag that cascade by one
   * increment. Null only if this driver's own raw result is missing (should
   * not normally happen — see the "skip rather than fabricate a row" guard
   * below).
   */
  classPosition: number | null;
  /** This driver's grid position within their own class that race (raw curated_race_results.starting_position, re-ranked the same way as classPosition) — null if starting_position itself is missing. */
  classStartingPosition: number | null;
  wasAdjusted: boolean;
  /** True when the penalty/adjustment engine MOVED this driver UP the order (finishPosition < the raw, pre-adjustment finish_position) — false for a loss or an unadjusted row. Lets a caller color the "adjusted" marker by direction (gained vs. lost) instead of one flat color. */
  gainedPositions: boolean;
  margin: string;
  intervalTenThousandths: number | null;
  incidents: number | null;
  laps: number | null;
  lapsLed: number | null;
  /** This race's lap count × its resolved circuit layout's corner count (see DriverSeasonExtendedStats.totalCorners for the same idea at season granularity) — null whenever this round didn't resolve to a layout with a corner count on file. Used to compute CPI (corners per incident) for a Splits group, by summing this and `incidents` across every race in the group rather than averaging each race's own ratio. */
  totalCorners: number | null;
  /** Raw OVERALL qualifying position (every class combined), from `curated_qualifying.qual_position` — attributed to race 1 of this round only, since race 2/3 grids invert off race 1 rather than running real qualifying (see computeOverallSeasonStandings' own "only race with real qualifying" comment). See classQualPosition for this driver's position within their own class. Null on race 2/3 of a multi-race round, or if this driver has no `curated_qualifying` row for this round. */
  qualPosition: number | null;
  /** This driver's qualifying position within their own class that round (race 1 only, re-ranked from `curated_qualifying.qual_position` restricted to the other drivers who shared their class that round — same class-relative approach as `classPosition`). Null under the same race-2/3 condition as `qualPosition`, or if this driver's class couldn't be determined for that round. */
  classQualPosition: number | null;
  totalPoints: number;
  dsq: boolean;
  classified: boolean;
  /** This race's own best lap (ten-thousandths of a second), straight off getLapStatsForSubsessions — null when lap stats weren't recorded for this race. Powers the driver profile's Bests tab: grouping every race with the same layoutLabel and taking the minimum across this field gives this driver's personal best at that layout. Unlike bestLapTenThousandths on RaceResultRow, there's no pre-formatted sibling field here — the Bests tab formats the post-grouping MINIMUM, not any one race's own value, so formatting a single race's raw number here would go unused. */
  bestLapTenThousandths: number | null;
  /** The raw curated_rounds.layout text for this specific race (e.g. "Junior", or null when unset) — NOT the same as layoutLabel above, which is trackName plus this value already combined into one display string. Kept separately so the Bests tab can show Track and Layout as two distinct sortable columns rather than having to re-split layoutLabel back apart. Null (rather than "N/A"'s own sentinel — see displayLayoutName) when this round never had a layout value on file at all. */
  roundLayoutText: string | null;
  /**
   * This layout's curated Track Record (`circuit_layouts.lap_record_seconds`
   * — the same admin-entered figure shown on the Circuits and Event
   * Briefing pages, via `resolveLayout`'s same trackName/layout matching
   * used for `totalCorners` above), in seconds. Per Logan: the Bests tab's
   * "Track Record" column should read this curated figure, not a freshly
   * computed "fastest ATC lap on file" — that field can be null (no record
   * entered yet) or even predate/exceed ATC's own results (see
   * resolveLapRecordCar's own doc comment), same caveats as everywhere else
   * on the site this field is shown. Null whenever resolveLayout can't pin
   * this round to one specific circuit_layouts row, or that row has no
   * record on file.
   */
  layoutRecordSeconds: number | null;
}

/**
 * Every race this driver has ever run, most recent first. Exhibition and
 * test rounds are excluded — same "excluded from all statistics" rule
 * every other career/season stat in this file follows (see
 * `isChampionshipSeason`'s own doc comment) — this is a driver's
 * competitive race history, not a literal server log of every session
 * their cust_id ever appeared in.
 *
 * Bulk-fetch-once throughout, same discipline as computeDriverCareerStats:
 * one race_scores query filtered to this driver (however many seasons that
 * spans), one curated_race_results query across the resulting
 * subsession_ids (which also pulls in every OTHER driver's row for those
 * same subsessions — needed to find each race's leader for formatMargin),
 * and one getAllRounds() — never a per-season or per-round loop.
 */
export async function getDriverRaceHistory(
  env: SupabaseEnv,
  driverId: string,
): Promise<DriverRaceHistoryRow[]> {
  const driverRows = await restGet<{ id: string; iracing_cust_id: number | null }[]>(
    env,
    `drivers?select=id,iracing_cust_id&id=eq.${encodeURIComponent(driverId)}`,
  );
  const custId = driverRows[0]?.iracing_cust_id ?? null;
  // No cust_id on file means this driver can never have a curated_race_results
  // row to join against (that table only knows cust_id, not driver_id) —
  // nothing to show rather than a crash.
  if (custId === null) return [];

  const scoreSelect = 'subsession_id,race_number,class_id,team_id,total_points,classified,dsq';
  const scores = await restGetAll<{
    subsession_id: number;
    race_number: number;
    class_id: number;
    team_id: string | null;
    total_points: number;
    classified: boolean;
    dsq: boolean;
  }>(
    env,
    `race_scores_public?select=${scoreSelect}&driver_id=eq.${encodeURIComponent(driverId)}&order=subsession_id.asc,race_number.asc`,
  );
  if (scores.length === 0) return [];

  const subsessionIds = [...new Set(scores.map((s) => s.subsession_id))];

  const [
    rawResults,
    teams,
    carLogos,
    classes,
    seasons,
    allRounds,
    exhibitionRoundIds,
    testRoundIds,
    seasonLogoRows,
    overallScoresRaw,
    penalties,
    lapStats,
    allDrivers,
    circuits,
    circuitLayouts,
    roundLayouts,
    qualifyingRowsBulk,
    rulesets,
  ] = await Promise.all([
    getCuratedRaceResultsForSubsessions(env, subsessionIds),
    getTeamsBasic(env),
    getCarLogos(env),
    getDriverClasses(env),
    getSeasons(env),
    getAllRounds(env),
    getExhibitionRoundIds(env),
    getTestRoundIds(env),
    getAllTeamSeasonLogosSafe(env),
    // Whole-field (every driver, not just this one) race_scores across
    // every subsession this driver has ever raced — see
    // getRaceScoresForSubsessionsOverall's own doc comment for why the
    // penalty engine's time-penalty reorder needs the full field.
    getRaceScoresForSubsessionsOverall(env, subsessionIds),
    getPenaltiesForSubsessions(env, subsessionIds),
    getLapStatsForSubsessions(env, subsessionIds),
    driversSelect(env, {}),
    // circuits/circuitLayouts/roundLayouts back the Splits card's CPI stat
    // (DriverRaceHistoryRow.totalCorners) — same "degrade the one feature,
    // never the whole page" isolation getSeasonDriverExtendedStats uses for
    // the identical lookup.
    getCircuits(env).catch((err) => {
      console.error(
        'Failed to fetch circuits for driver race-history corners-per-incident stats — CPI will be omitted:',
        err,
      );
      return [] as Circuit[];
    }),
    getAllCircuitLayouts(env).catch((err) => {
      console.error(
        'Failed to fetch circuit_layouts for driver race-history corners-per-incident stats — CPI will be omitted:',
        err,
      );
      return [] as CircuitLayout[];
    }),
    getRoundLayoutsForSubsessions(env, subsessionIds).catch((err) => {
      console.error(
        'Failed to fetch round layouts for driver race-history corners-per-incident stats — CPI will be omitted:',
        err,
      );
      return new Map<number, string | null>();
    }),
    getQualifyingForSubsessionsBulk(env, subsessionIds).catch((err) => {
      console.error(
        'Failed to fetch qualifying results for driver race history — Avg Qualify will be omitted:',
        err,
      );
      return [] as CuratedQualifyingBulkRow[];
    }),
    getScoringRulesets(env),
  ]);

  const excludedRoundIds = new Set([...exhibitionRoundIds, ...testRoundIds]);
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const classNameById = new Map(classes.map((c) => [c.id, c.name]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  const seasonById = new Map(seasons.map((s) => [s.id, s]));
  const roundBySubsession = new Map(allRounds.map((r) => [r.subsession_id, r]));
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  // Live penalty-adjustment engine — same one every other page (results,
  // standings, incidents, news recap) uses, recomputed from the CURRENT
  // penalties table on every render rather than relying on a manually
  // re-run DB function. Scoped by explicit subsession_ids (this driver's
  // whole career, spanning many seasons) rather than one season at a time —
  // the engine's own keying (`${subsessionId}:${raceNumber}:${driverId}`)
  // is season-agnostic, so this works the same as the single-season
  // buildSeasonOverallContext pattern used elsewhere in this file.
  const custIdByDriverId = new Map(
    allDrivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );
  const lapStatsByKey = new Map(
    lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]),
  );
  const formatBySubsession = new Map(allRounds.map((r) => [r.subsession_id, r.format]));
  // Unlike the single-season buildSeasonOverallContext pattern, this driver's
  // career can span MANY seasons, each potentially on its own
  // scoring_rulesets — so unlike that pattern's single repeated `rules`
  // value, this has to resolve each round's own season's ruleset
  // individually. See penalties.ts's computeSeasonOverallAdjustments'
  // `rulesBySubsession` param doc comment.
  const rulesBySubsession = new Map(
    allRounds.map((r) => {
      const roundSeason = seasonById.get(r.season_id);
      return [
        r.subsession_id,
        roundSeason ? (resolveSeasonRuleset(roundSeason, rulesets)?.rules ?? null) : null,
      ];
    }),
  );

  const seasonScoreRows: SeasonScoreRow[] = overallScoresRaw.map((s) => {
    const rowCustId = custIdByDriverId.get(s.driver_id);
    const rawForRow =
      rowCustId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, rowCustId)) : undefined;
    const lapStatsRow =
      rowCustId != null ? lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, rowCustId)) : undefined;
    return {
      subsessionId: s.subsession_id,
      raceNumber: s.race_number,
      driverId: s.driver_id,
      dsq: s.dsq,
      classified: s.classified,
      scoredPosition: s.scored_position,
      intervalTenThousandths: rawForRow?.interval_ten_thousandths ?? null,
      finishPoints: s.finish_points,
      finesseBonus: s.finesse_bonus,
      poleBonus: s.pole_bonus,
      aggressionBonus: s.aggression_bonus,
      pointsDeduction: s.points_deduction,
      lapsComplete: rawForRow?.laps_complete ?? null,
      averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
    };
  });
  const adjustments = computeSeasonOverallAdjustments(
    seasonScoreRows,
    penalties,
    formatBySubsession,
    rulesBySubsession,
  );

  // Leader's laps_complete per (subsession, race) — same as getRoundResults'
  // own leaderLapsByRace, just keyed across every round in scope at once
  // (this spans the driver's whole career, not one round).
  const leaderLapsByRace = new Map<string, number | null>();
  for (const r of rawResults) {
    if (r.finish_position === 1) {
      leaderLapsByRace.set(`${r.subsession_id}:${r.race_number}`, r.laps_complete);
    }
  }

  // Round numbering is scoped per season (see computeDisplayRoundNumbers'
  // own doc comment and every existing caller) — group ALL rounds (not just
  // this driver's own) by season once, then number each season's rounds off
  // its own full round list, exactly like a single-season page would.
  const roundsBySeason = new Map<string, RoundSummary[]>();
  for (const r of allRounds) {
    if (!roundsBySeason.has(r.season_id)) roundsBySeason.set(r.season_id, []);
    roundsBySeason.get(r.season_id)!.push(r);
  }
  const displayNumberBySubsession = new Map<number, number | null>();
  for (const seasonRounds of roundsBySeason.values()) {
    for (const [subsessionId, num] of computeDisplayRoundNumbers(
      seasonRounds,
      exhibitionRoundIds,
      testRoundIds,
    )) {
      displayNumberBySubsession.set(subsessionId, num);
    }
  }

  // Class-relative finish/start position — see DriverRaceHistoryRow.classPosition's
  // own doc comment for why this can't just reuse `finishPosition`/
  // `startingPosition` above (both OVERALL fields). Grouped by
  // subsession+race+class across `overallScoresRaw` (every driver's row,
  // every class, for every subsession this driver ever raced) so each
  // group is exactly "who else raced this driver's own class in this
  // specific race" — then ranked in memory, no extra fetch.
  interface ClassFieldEntry {
    driverId: string;
    finishPos: number | null;
    startPos: number | null;
    dsq: boolean;
  }
  const classFieldByRace = new Map<string, ClassFieldEntry[]>();
  for (const s of overallScoresRaw) {
    const rowCustId = custIdByDriverId.get(s.driver_id);
    const rawForRow =
      rowCustId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, rowCustId)) : undefined;
    const key = `${s.subsession_id}:${s.race_number}:${s.class_id}`;
    if (!classFieldByRace.has(key)) classFieldByRace.set(key, []);
    classFieldByRace.get(key)!.push({
      driverId: s.driver_id,
      finishPos: rawForRow ? (rawForRow.adjusted_position ?? rawForRow.finish_position) : null,
      startPos: rawForRow?.starting_position ?? null,
      dsq: s.dsq,
    });
  }
  const classPositionByKey = new Map<string, number>();
  const classStartingPositionByKey = new Map<string, number>();
  for (const [key, field] of classFieldByRace) {
    // key is "subsessionId:raceNumber:classId" — classId isn't needed past
    // this point, only the subsession+race prefix the per-driver maps key on.
    const [subsessionIdStr, raceNumberStr] = key.split(':');
    const prefix = `${subsessionIdStr}:${raceNumberStr}`;
    field
      .filter((f) => !f.dsq && f.finishPos !== null)
      .sort((a, b) => (a.finishPos as number) - (b.finishPos as number))
      .forEach((f, i) => classPositionByKey.set(`${prefix}:${f.driverId}`, i + 1));
    field
      .filter((f) => f.startPos !== null)
      .sort((a, b) => (a.startPos as number) - (b.startPos as number))
      .forEach((f, i) => classStartingPositionByKey.set(`${prefix}:${f.driverId}`, i + 1));
  }

  // Corners-per-incident numerator (see DriverRaceHistoryRow.totalCorners'
  // own doc comment) — same resolveLayout-based lookup
  // getSeasonDriverExtendedStats uses, just keyed across this driver's whole
  // career's subsessions instead of one season's.
  const cornersBySubsession = new Map<number, number | null>();
  // See DriverRaceHistoryRow.layoutLabel's own doc comment — this is just
  // trackName plus curated_rounds.layout (the round's own raw configuration
  // text, e.g. "Grand Prix"), NOT resolveLayout's resolved circuit_layouts
  // row (that lookup can fail to match a row at all — see resolveLayout's
  // doc comment — and this label should still distinguish configurations
  // even then, straight off the source data).
  const layoutLabelBySubsession = new Map<number, string>();
  // The same resolved circuit_layouts row this loop already looks up for
  // totalCorners' corner count — also carries lap_record_seconds, the
  // Bests tab's "Track Record" column (see DriverRaceHistoryRow.
  // layoutRecordSeconds' own doc comment for why this reuses the curated
  // figure rather than computing one fresh). No extra fetch: `layout` below
  // is the one resolveLayout() call this loop already makes per subsession.
  const layoutRecordBySubsession = new Map<number, number | null>();
  for (const subsessionId of subsessionIds) {
    const trackName = roundBySubsession.get(subsessionId)?.track_name;
    const layout = trackName
      ? resolveLayout(trackName, roundLayouts.get(subsessionId) ?? null, circuits, circuitLayouts)
      : null;
    cornersBySubsession.set(subsessionId, layout?.corners ?? null);
    layoutRecordBySubsession.set(subsessionId, layout?.lap_record_seconds ?? null);
    const rawLayoutText = roundLayouts.get(subsessionId);
    layoutLabelBySubsession.set(
      subsessionId,
      rawLayoutText ? `${trackName ?? '—'} — ${rawLayoutText}` : (trackName ?? '—'),
    );
  }

  // Qualifying (see DriverRaceHistoryRow.qualPosition/classQualPosition's own
  // doc comments) — overall position comes straight off curated_qualifying;
  // class-relative position is re-derived the same way classPosition is
  // above, grouping by (subsession, classId) rather than (subsession,
  // raceNumber, classId) since qualifying is one session per ROUND, not per
  // race. A driver's class for a round is read off any of their
  // `overallScoresRaw` rows for that subsession (class doesn't change
  // race-to-race within one round — see getQualifyingForSubsession's own
  // comment for the same assumption).
  const classIdBySubsessionDriver = new Map<string, number>();
  for (const s of overallScoresRaw) {
    const key = `${s.subsession_id}:${s.driver_id}`;
    if (!classIdBySubsessionDriver.has(key)) classIdBySubsessionDriver.set(key, s.class_id);
  }
  const driverIdByCustId = new Map<number, string>();
  for (const d of allDrivers) {
    if (d.iracing_cust_id != null) driverIdByCustId.set(d.iracing_cust_id, d.id);
  }
  const qualPositionBySubsessionDriver = new Map<string, number | null>();
  const qualFieldBySubsessionClass = new Map<string, { driverId: string; qualPos: number | null }[]>();
  for (const q of qualifyingRowsBulk) {
    const qDriverId = driverIdByCustId.get(q.cust_id);
    if (!qDriverId) continue; // this cust_id has no matching drivers row (unrostered/AI) — not something this driver's history needs
    qualPositionBySubsessionDriver.set(`${q.subsession_id}:${qDriverId}`, q.qual_position);
    const classId = classIdBySubsessionDriver.get(`${q.subsession_id}:${qDriverId}`);
    if (classId === undefined) continue; // qualified but never appears in race_scores for this round — can't place them in a class field
    const key = `${q.subsession_id}:${classId}`;
    if (!qualFieldBySubsessionClass.has(key)) qualFieldBySubsessionClass.set(key, []);
    qualFieldBySubsessionClass.get(key)!.push({ driverId: qDriverId, qualPos: q.qual_position });
  }
  const classQualPositionBySubsessionDriver = new Map<string, number>();
  for (const [key, field] of qualFieldBySubsessionClass) {
    const subsessionIdStr = key.split(':')[0];
    field
      .filter((f) => f.qualPos !== null)
      .sort((a, b) => (a.qualPos as number) - (b.qualPos as number))
      .forEach((f, i) => classQualPositionBySubsessionDriver.set(`${subsessionIdStr}:${f.driverId}`, i + 1));
  }

  const out: DriverRaceHistoryRow[] = [];
  for (const score of scores) {
    if (excludedRoundIds.has(score.subsession_id)) continue;
    const raw = rawByKey.get(resultKey(score.subsession_id, score.race_number, custId));
    if (!raw) continue; // shouldn't happen (a scored race always has a matching raw result) — skip rather than fabricate a row
    const round = roundBySubsession.get(score.subsession_id) ?? null;
    const team = score.team_id ? (teamById.get(score.team_id) ?? null) : null;

    // Live-engine position/points first, legacy manual override next, raw
    // last — see DriverRaceHistoryRow.finishPosition's doc comment. An NC/DSQ
    // row is never repositioned by the engine (canReposition requires
    // classified === true), so it falls straight through to the legacy/raw
    // value exactly as before.
    const adjustment = adjustments.get(`${score.subsession_id}:${score.race_number}:${driverId}`);
    const baselinePosition = raw.adjusted_position ?? raw.finish_position;
    const finishPosition = adjustment?.newPosition ?? baselinePosition;
    const totalPoints = adjustment?.overallTotalPoints ?? score.total_points;

    const cornersForRound = cornersBySubsession.get(score.subsession_id) ?? null;
    const totalCorners = cornersForRound !== null ? (raw.laps_complete ?? 0) * cornersForRound : null;
    // Only race 1 of a round has real qualifying — see this field's own doc
    // comment.
    const isQualifyingRace = score.race_number === 1;
    const qualPosition = isQualifyingRace
      ? (qualPositionBySubsessionDriver.get(`${score.subsession_id}:${driverId}`) ?? null)
      : null;
    const classQualPosition = isQualifyingRace
      ? (classQualPositionBySubsessionDriver.get(`${score.subsession_id}:${driverId}`) ?? null)
      : null;

    out.push({
      subsessionId: score.subsession_id,
      raceNumber: score.race_number,
      season: round ? (seasonById.get(round.season_id) ?? null) : null,
      trackName: round?.track_name ?? '—',
      layoutLabel: layoutLabelBySubsession.get(score.subsession_id) ?? round?.track_name ?? '—',
      startTime: round?.start_time ?? '',
      displayRoundNumber: displayNumberBySubsession.get(score.subsession_id) ?? null,
      classId: score.class_id,
      className: classNameById.get(score.class_id) ?? '',
      car: raw.car_name ? { name: raw.car_name, logoUrl: carLogoByName.get(raw.car_name) ?? null } : null,
      team: team
        ? { name: team.name, logoUrl: resolveTeamLogo(team, round?.season_id ?? null, seasonLogoMap) }
        : null,
      startingPosition: raw.starting_position,
      finishPosition,
      classPosition:
        classPositionByKey.get(`${score.subsession_id}:${score.race_number}:${driverId}`) ?? null,
      classStartingPosition:
        classStartingPositionByKey.get(`${score.subsession_id}:${score.race_number}:${driverId}`) ?? null,
      wasAdjusted: finishPosition !== raw.finish_position,
      gainedPositions: finishPosition < raw.finish_position,
      margin: formatMargin(
        raw.interval_ten_thousandths,
        raw.laps_complete,
        leaderLapsByRace.get(`${score.subsession_id}:${score.race_number}`) ?? null,
      ),
      intervalTenThousandths: raw.interval_ten_thousandths,
      incidents: raw.incidents,
      laps: raw.laps_complete,
      lapsLed: raw.laps_led,
      totalCorners,
      qualPosition,
      classQualPosition,
      totalPoints,
      dsq: score.dsq,
      classified: score.classified,
      bestLapTenThousandths:
        lapStatsByKey.get(resultKey(score.subsession_id, score.race_number, custId))
          ?.best_lap_ten_thousandths ?? null,
      roundLayoutText: roundLayouts.get(score.subsession_id) ?? null,
      layoutRecordSeconds: layoutRecordBySubsession.get(score.subsession_id) ?? null,
    });
  }

  // Most recent race first — start_time, then race_number as a tiebreaker
  // within the same round (so race1/race2/race3 stay in run order even
  // though the whole list is newest-round-first).
  out.sort((a, b) => {
    const t = new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
    return t !== 0 ? t : b.raceNumber - a.raceNumber;
  });

  return out;
}
