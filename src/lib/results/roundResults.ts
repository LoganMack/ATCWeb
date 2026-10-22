import type { SupabaseEnv } from '../db/client';
import { getCarLogos } from '../db/assets';
import { getPenaltiesForSubsession, type Penalty } from '../db/penalties';
import { formatLapTime } from '../db/circuits';
import {
  getCuratedRaceResultsForSubsessions,
  driversSelect,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  getLapStatsForSubsessions,
  getDisplayNamesForSubsessions,
  getRaceScoresForSubsession,
  resultKey,
  buildSeasonLogoMap,
  resolveTeamLogo,
  type DriverBasic,
  type ScoreRow,
  type CuratedRaceResultRow,
} from './rows';
import { getRoundBySubsessionId } from './rounds';
import { formatMargin } from './format';
import {
  fillUnrosteredPositions,
  formatRaceTime,
  overallRaceTimeTenThousandths,
  penalisedGaps,
  penalisedInterval,
  penalisedMargin,
  shownOldPosition,
  timePenaltiesByRaceDriver,
} from './raceDisplay';

export interface RaceResultRow {
  raceNumber: number;
  classId: number;
  /**
   * null for a disqualified driver — they're listed but don't occupy a
   * position. The shown class position in the per-class view, the shown
   * overall position in the overall view (race_score_results_public: the
   * penalised order once the round is posted).
   */
  position: number | null;
  dsq: boolean;
  driver: DriverBasic;
  finishPosition: number;
  startingPosition: number | null;
  wasAdjusted: boolean;
  totalPoints: number;
  /**
   * Everything in `totalPoints` (the shown class_total) except the finish
   * points: class points, every bonus, and `pointsDeduction`.
   */
  bonusPoints: number;
  /**
   * `totalPoints` before this round's penalties (the raw class total), for
   * the results table's "Penalty Adjustment" line (`totalPoints -
   * originalTotalPoints`) and the incident page's points delta. Equal to
   * `totalPoints` when the reader sees the raw set, so the line stays hidden.
   */
  originalTotalPoints: number;
  /** The individual components `bonusPoints` above is the sum of. */
  classPoints: number;
  finesseBonus: number;
  poleBonus: number;
  /** "Naked Aggression" bonus (0033_naked_aggression_bonus.sql) — most net positions gained this race, see `aggressionBonusWon`. */
  aggressionBonus: number;
  /** Four new per-class/per-race bonuses (0067_ruleset_overhaul_and_bonuses.sql), each disabled per-ruleset unless its `rules.bonuses.<key>.enabled` flag is set — see admin/rulesets. Same "folded into total_points" reasoning as aggressionBonus above. */
  lapLedBonus: number;
  fewestIncidentsBonus: number;
  fastestLapBonus: number;
  sprintSweepBonus: number;
  /** The deduction as a signed addend (0 or negative), as the breakdown shows it. */
  pointsDeduction: number;
  polePosition: boolean;
  /** True when `finesse_bonus > 0` — the "3 incidents or less" bonus was actually awarded for this race (mirrors `polePosition`'s use of `pole_bonus > 0` rather than re-deriving the rule from a raw threshold). */
  incidentsBonus: boolean;
  /** True when `aggression_bonus > 0` — this driver actually won the Naked Aggression bonus this race (mirrors `polePosition`/`incidentsBonus`'s use of their own bonus column). */
  aggressionBonusWon: boolean;
  /** True when the respective new bonus column (lap_led_bonus/fewest_incidents_bonus/fastest_lap_bonus/sprint_sweep_bonus) is > 0 this race — same pattern as aggressionBonusWon, for ResultsTable's badges. */
  lapLedWon: boolean;
  fewestIncidentsWon: boolean;
  fastestLapWon: boolean;
  sprintSweepWon: boolean;
  incidents: number | null;
  laps: number | null;
  lapsLed: number | null;
  /**
   * Result tags such as "Unclassified" (taken from `race_score_results.classified`). A list so more tags can
   * sit beside it.
   */
  tags: string[];
  /**
   * Gap to this view's leader (the race leader in Overall, the class leader in Per Class, so one driver's
   * margin can differ between views): "xx.xxx" seconds, "—" for the leader or no interval, "-xL" when
   * iRacing's negative interval means laps down. Includes visible penalties (raceDisplay.ts).
   */
  margin: string;
  /** The gap to the race leader in ten-thousandths of a second (negative = laps down). */
  intervalTenThousandths: number | null;
  /** The position before this round's penalties when they moved this driver (their own, or another driver's that cascaded past them), so the UI can show it struck through next to the new one. Null when unaffected. */
  penaltyOldPosition: number | null;
  /** True when a penalty this reader may see is logged against this driver for this race. */
  hasPenalty: boolean;
  /** The team this driver raced for in this specific race (from `team_id`), or null if unassigned. `logoUrl` is that team's logo AS OF this round's season (0019_team_season_logos.sql) when a historical override exists, otherwise the team's current logo. */
  team: { name: string; logoUrl: string | null } | null;
  /** The car this driver used for this specific race (`curated_race_results.car_name`), or null if not recorded. */
  car: { name: string; logoUrl: string | null } | null;
  /**
   * "1:42.512"-formatted average lap (`formatLapTime` in src/lib/db/circuits.ts) from an isolated fetch
   * (getLapStatsForSubsessions); "—" when the pipeline has none.
   */
  averageLapFormatted: string;
  /** Raw ten-thousandths-of-a-second value averageLapFormatted is formatted from — kept unformatted, same reasoning as intervalTenThousandths, so applyPenaltyDisplay can do exact integer math with it (rule 18.3.2's "own laps × own average lap") rather than round-tripping through the display string. Null when there's no data. */
  averageLapTenThousandths: number | null;
  /** This driver's single fastest lap the race, formatted the same way. Same source/isolation as averageLapFormatted. */
  bestLapFormatted: string;
  /** Raw ten-thousandths-of-a-second value bestLapFormatted is formatted from — kept unformatted so callers can do numeric comparisons (e.g. against a driver's personal-best at this track, see getDriverBestLapsAtTrack) without round-tripping through the display string. Null when there's no data. */
  bestLapTenThousandths: number | null;
  /**
   * "Overall race time" — own laps × own average lap (rule 18.3.2's method
   * for comparing drivers who aren't on the lead lap) — "—" whenever
   * averageLapTenThousandths is null. Includes the driver's own time
   * penalty when the round's penalties are visible to the reader.
   */
  overallRaceTimeFormatted: string;
  /** Raw ten-thousandths-of-a-second value overallRaceTimeFormatted is formatted from — same reasoning as averageLapTenThousandths. Null when there's no data to compute it from. */
  overallRaceTimeTenThousandths: number | null;
  /**
   * An entrant who raced but has no `drivers` row, so scoring never produced a row for them. Overall view
   * only (their class is unknown), never scored, placed in the next position the rostered rows leave free
   * (fillUnrosteredPositions).
   */
  notInRoster: boolean;
}

export interface RoundResults {
  /** class_id -> race_number -> rows, ranked class-relative. */
  byClass: Map<number, Map<number, RaceResultRow[]>>;
  /** race_number -> rows (every class combined), ranked by overall field position. */
  overall: Map<number, RaceResultRow[]>;
  /** The round's penalties this reader may see (RLS hides an unposted round's from non-admins). */
  penalties: Penalty[];
}

/**
 * Race-by-race results for one round, by class and overall. Positions, points and re-ordered gaps come from
 * race_score_results_public, penalties included when the reader may see them (BR4.1, BR4.2). Rows keep raw
 * finishing order; a moved row shows its new position beside the struck-through old one.
 */
export async function getRoundResults(env: SupabaseEnv, subsessionId: number): Promise<RoundResults> {
  const [
    scores,
    rawResults,
    drivers,
    teams,
    carLogos,
    round,
    seasonLogoRows,
    lapStats,
    displayNames,
    penalties,
  ] = await Promise.all([
    getRaceScoresForSubsession(env, subsessionId),
    getCuratedRaceResultsForSubsessions(env, [subsessionId]),
    driversSelect(env, { includeAi: true }),
    getTeamsBasic(env),
    getCarLogos(env),
    getRoundBySubsessionId(env, subsessionId),
    getAllTeamSeasonLogosSafe(env),
    getLapStatsForSubsessions(env, [subsessionId]),
    getDisplayNamesForSubsessions(env, [subsessionId]),
    getPenaltiesForSubsession(env, subsessionId),
  ]);

  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const custIdByDriverId = new Map(
    drivers.filter((d) => d.iracing_cust_id != null).map((d) => [d.id, d.iracing_cust_id as number]),
  );
  // Every cust_id this app actually has a driver for — anyone in
  // curated_race_results whose cust_id isn't in here raced this round but
  // was never added to the roster at all (see toUnrosteredRow below).
  const rosteredCustIds = new Set(custIdByDriverId.values());
  const rawByKey = new Map(rawResults.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]));
  const lapStatsByKey = new Map(
    lapStats.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r]),
  );
  const displayNameByKey = new Map(
    displayNames.map((r) => [resultKey(r.subsession_id, r.race_number, r.cust_id), r.display_name]),
  );
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const carLogoByName = new Map(carLogos.map((c) => [c.car_name, c.logo_url]));
  // This round's season, for the historical-logo lookup below — team logos
  // shown on this round's results should reflect what the team looked like
  // THAT season (0019_team_season_logos.sql), not necessarily today.
  const seasonId = round?.season_id ?? null;
  const seasonLogoMap = buildSeasonLogoMap(seasonLogoRows);

  // Leader's laps_complete per race (finish_position === 1, i.e. the actual
  // on-track winner before any penalty adjustment) — needed to turn a
  // lapped driver's negative interval into a "-xL" margin. See
  // `formatMargin`.
  const leaderLapsByRace = new Map<number, number | null>();
  for (const r of rawResults) {
    if (r.finish_position === 1) leaderLapsByRace.set(r.race_number, r.laps_complete);
  }

  // The penalties shape the display only when the reader sees the final set.
  const finalShown = scores.some((sc) => sc.set === 'final');

  function toRow(
    score: ScoreRow,
    driver: DriverBasic,
    raw: CuratedRaceResultRow,
    position: number | null,
    oldPosition: number | null,
    /**
     * When set, this row's margin is measured against THIS driver (the
     * class leader) instead of the race's overall on-track leader — used by
     * the byClass construction below so the Per Class view shows distance
     * to the class leader rather than distance to the overall winner. Left
     * unset for the Overall view's own toRow() calls.
     */
    classLeaderRaw: CuratedRaceResultRow | null = null,
  ): RaceResultRow {
    const team = score.team_id ? (teamById.get(score.team_id) ?? null) : null;
    const lapStatsRow = lapStatsByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id));
    const averageLapTenThousandths = lapStatsRow?.average_lap_ten_thousandths ?? null;
    const bestLapTenThousandths = lapStatsRow?.best_lap_ten_thousandths ?? null;
    const overallRaceTime = overallRaceTimeTenThousandths(raw.laps_complete, averageLapTenThousandths, null);
    const margin = classLeaderRaw
      ? formatMargin(
          raw.interval_ten_thousandths,
          raw.laps_complete,
          classLeaderRaw.laps_complete,
          classLeaderRaw.interval_ten_thousandths,
        )
      : formatMargin(
          raw.interval_ten_thousandths,
          raw.laps_complete,
          leaderLapsByRace.get(score.race_number) ?? null,
        );
    const pointsDeduction = -score.points_deduction;
    const tags: string[] = [];
    // `classified` is computed upstream by the results pipeline itself
    // (Logan: "anyone finishing less than 50% of the leader's laps do not
    // score any points and are unclassified") — trusting that field here
    // instead of re-deriving the 50% threshold in app code.
    if (!score.classified) tags.push('Unclassified');
    // 0057_driver_ai_flag.sql — flags this row as an AI-controlled entrant
    // rather than letting it look like an unexplained/unfamiliar name.
    if (driver.is_ai) tags.push('AI');

    return {
      raceNumber: score.race_number,
      classId: score.class_id,
      position,
      dsq: score.dsq,
      driver,
      finishPosition: raw.finish_position,
      startingPosition: raw.starting_position,
      wasAdjusted:
        (raw.adjusted_position !== null && raw.adjusted_position !== raw.finish_position) ||
        oldPosition !== null,
      totalPoints: score.class_total,
      originalTotalPoints: score.set === 'final' ? score.raw_class_total : score.class_total,
      bonusPoints:
        score.class_points +
        score.finesse_bonus +
        score.pole_bonus +
        score.aggression_bonus +
        score.lap_led_bonus +
        score.fewest_incidents_bonus +
        score.fastest_lap_bonus +
        score.sprint_sweep_bonus +
        pointsDeduction,
      classPoints: score.class_points,
      finesseBonus: score.finesse_bonus,
      poleBonus: score.pole_bonus,
      aggressionBonus: score.aggression_bonus,
      lapLedBonus: score.lap_led_bonus,
      fewestIncidentsBonus: score.fewest_incidents_bonus,
      fastestLapBonus: score.fastest_lap_bonus,
      sprintSweepBonus: score.sprint_sweep_bonus,
      pointsDeduction,
      polePosition: score.pole_bonus > 0,
      incidentsBonus: score.finesse_bonus > 0,
      aggressionBonusWon: score.aggression_bonus > 0,
      lapLedWon: score.lap_led_bonus > 0,
      fewestIncidentsWon: score.fewest_incidents_bonus > 0,
      fastestLapWon: score.fastest_lap_bonus > 0,
      sprintSweepWon: score.sprint_sweep_bonus > 0,
      incidents: raw.incidents,
      laps: raw.laps_complete,
      lapsLed: raw.laps_led,
      tags,
      margin,
      intervalTenThousandths: raw.interval_ten_thousandths,
      penaltyOldPosition: oldPosition,
      hasPenalty: false,
      team: team ? { name: team.name, logoUrl: resolveTeamLogo(team, seasonId, seasonLogoMap) } : null,
      car: raw.car_name ? { name: raw.car_name, logoUrl: carLogoByName.get(raw.car_name) ?? null } : null,
      averageLapFormatted: formatLapTime(
        averageLapTenThousandths !== null ? averageLapTenThousandths / 10000 : null,
      ),
      averageLapTenThousandths,
      bestLapFormatted: formatLapTime(bestLapTenThousandths !== null ? bestLapTenThousandths / 10000 : null),
      bestLapTenThousandths,
      overallRaceTimeFormatted: formatRaceTime(overallRaceTime),
      overallRaceTimeTenThousandths: overallRaceTime,
      notInRoster: false,
    };
  }

  /**
   * A row for an entrant with no `drivers` row (see RaceResultRow.notInRoster): real race data as in toRow(),
   * with points, team, bonuses and class zeroed.
   */
  function toUnrosteredRow(
    raw: CuratedRaceResultRow,
    position: number | null,
    oldPosition: number | null,
  ): RaceResultRow {
    const lapStatsRow = lapStatsByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id));
    const averageLapTenThousandths = lapStatsRow?.average_lap_ten_thousandths ?? null;
    const bestLapTenThousandths = lapStatsRow?.best_lap_ten_thousandths ?? null;
    const overallRaceTimeTenThousandths =
      averageLapTenThousandths !== null && raw.laps_complete !== null
        ? raw.laps_complete * averageLapTenThousandths
        : null;
    const displayName =
      displayNameByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id)) ??
      `Cust #${raw.cust_id}`;

    return {
      raceNumber: raw.race_number,
      // No class to place them under — never used, since unmatched rows
      // only ever go into the Overall view (getRoundResults never adds
      // them to byClass). A real class id would wrongly imply a per-class
      // view could show them.
      classId: -1,
      position,
      dsq: false,
      driver: {
        id: `unrostered:${raw.cust_id}`,
        name: displayName,
        car_number: null,
        photo_url: null,
        iracing_cust_id: raw.cust_id,
        is_rookie: false,
        nationality_1: null,
        nationality_2: null,
        is_ai: false,
      },
      finishPosition: raw.finish_position,
      startingPosition: raw.starting_position,
      wasAdjusted: oldPosition !== null,
      totalPoints: 0,
      originalTotalPoints: 0,
      bonusPoints: 0,
      classPoints: 0,
      finesseBonus: 0,
      poleBonus: 0,
      aggressionBonus: 0,
      lapLedBonus: 0,
      fewestIncidentsBonus: 0,
      fastestLapBonus: 0,
      sprintSweepBonus: 0,
      pointsDeduction: 0,
      polePosition: false,
      incidentsBonus: false,
      aggressionBonusWon: false,
      lapLedWon: false,
      fewestIncidentsWon: false,
      fastestLapWon: false,
      sprintSweepWon: false,
      incidents: raw.incidents,
      laps: raw.laps_complete,
      lapsLed: raw.laps_led,
      tags: ['Driver not listed in roster'],
      margin: formatMargin(
        raw.interval_ten_thousandths,
        raw.laps_complete,
        leaderLapsByRace.get(raw.race_number) ?? null,
      ),
      intervalTenThousandths: raw.interval_ten_thousandths,
      penaltyOldPosition: oldPosition,
      hasPenalty: false,
      team: null,
      car: raw.car_name ? { name: raw.car_name, logoUrl: carLogoByName.get(raw.car_name) ?? null } : null,
      averageLapFormatted: formatLapTime(
        averageLapTenThousandths !== null ? averageLapTenThousandths / 10000 : null,
      ),
      averageLapTenThousandths,
      bestLapFormatted: formatLapTime(bestLapTenThousandths !== null ? bestLapTenThousandths / 10000 : null),
      bestLapTenThousandths,
      overallRaceTimeFormatted: formatLapTime(
        overallRaceTimeTenThousandths !== null ? overallRaceTimeTenThousandths / 10000 : null,
      ),
      overallRaceTimeTenThousandths,
      notInRoster: true,
    };
  }

  interface Matched {
    score: ScoreRow;
    driver: DriverBasic;
    raw: CuratedRaceResultRow;
  }
  const matched: Matched[] = [];
  for (const s of scores) {
    const driver = driverById.get(s.driver_id);
    const custId = custIdByDriverId.get(s.driver_id);
    const raw = custId != null ? rawByKey.get(resultKey(s.subsession_id, s.race_number, custId)) : undefined;
    if (driver && raw) matched.push({ score: s, driver, raw });
  }

  // --- Per class: the shown class position, rows in raw class order ---
  const byClassThenRace = new Map<number, Map<number, Matched[]>>();
  for (const m of matched) {
    if (!byClassThenRace.has(m.score.class_id)) byClassThenRace.set(m.score.class_id, new Map());
    const byRace = byClassThenRace.get(m.score.class_id)!;
    if (!byRace.has(m.score.race_number)) byRace.set(m.score.race_number, []);
    byRace.get(m.score.race_number)!.push(m);
  }

  const byClass = new Map<number, Map<number, RaceResultRow[]>>();
  for (const [classId, byRace] of byClassThenRace) {
    const classOut = new Map<number, RaceResultRow[]>();
    for (const [raceNumber, group] of byRace) {
      const rawPos = (m: Matched) => m.score.finish_position;
      // Disqualified drivers don't occupy a class position — everyone else
      // ranks as if they weren't there — but they're still listed, at the
      // bottom, so the results page shows the complete field.
      const ranked = group.filter((m) => !m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      const dsqd = group.filter((m) => m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      // The class leader (this class's own P1, pre-penalty) — every row in
      // this class/race is measured against them for margin display in the
      // Per Class view. Null when the whole class is DSQ'd (toRow() then
      // measures against the overall leader).
      const classLeaderRaw = ranked.length > 0 ? ranked[0].raw : null;
      classOut.set(raceNumber, [
        ...ranked.map((m) =>
          toRow(
            m.score,
            m.driver,
            m.raw,
            m.score.class_position,
            shownOldPosition(m.score.class_position, m.score.raw_class_position),
            classLeaderRaw,
          ),
        ),
        ...dsqd.map((m) => toRow(m.score, m.driver, m.raw, null, null, classLeaderRaw)),
      ]);
    }
    byClass.set(classId, classOut);
  }

  // --- Overall: every class combined, rows in raw finishing order ---
  const byRaceAll = new Map<number, Matched[]>();
  for (const m of matched) {
    if (!byRaceAll.has(m.score.race_number)) byRaceAll.set(m.score.race_number, []);
    byRaceAll.get(m.score.race_number)!.push(m);
  }

  // Entrants who actually raced (present in curated_race_results) but have
  // no matching `drivers` row at all — see toUnrosteredRow/notInRoster's
  // own doc comments. Grouped by race the same way `matched` is above.
  const unmatchedByRace = new Map<number, CuratedRaceResultRow[]>();
  for (const raw of rawResults) {
    if (rosteredCustIds.has(raw.cust_id)) continue;
    if (!unmatchedByRace.has(raw.race_number)) unmatchedByRace.set(raw.race_number, []);
    unmatchedByRace.get(raw.race_number)!.push(raw);
  }

  const overallRawPos = (m: Matched) => m.score.finish_position;
  const unrosteredRawPos = (raw: CuratedRaceResultRow) => raw.adjusted_position ?? raw.finish_position;
  const overall = new Map<number, RaceResultRow[]>();
  const allRaceNumbers = new Set<number>([...byRaceAll.keys(), ...unmatchedByRace.keys()]);
  for (const raceNumber of allRaceNumbers) {
    const group = byRaceAll.get(raceNumber) ?? [];
    const unmatchedGroup = unmatchedByRace.get(raceNumber) ?? [];
    const ranked = group
      .filter((m) => !m.score.dsq && m.score.position !== null)
      .sort((a, b) => overallRawPos(a) - overallRawPos(b));
    // Anything without a position (a DSQ) is listed after, in raw order,
    // without a position — consistent with the per-class view.
    const unranked = group
      .filter((m) => m.score.dsq || m.score.position === null)
      .sort((a, b) => overallRawPos(a) - overallRawPos(b));

    // finish_position is the same raw finish/adjusted slot every entrant has
    // on curated_race_results, so an unrostered entrant sorts correctly
    // alongside everyone else, keeping the Overall view a complete,
    // truthfully-ordered field instead of tacking unrostered rows onto the end.
    const unrostered = [...unmatchedGroup].sort((a, b) => unrosteredRawPos(a) - unrosteredRawPos(b));
    const unrosteredPositions = fillUnrosteredPositions(
      ranked.map((m) => m.score.position as number),
      unrostered.length,
    );
    const rankedAndUnrostered = [
      ...ranked.map((m) => ({
        row: toRow(
          m.score,
          m.driver,
          m.raw,
          m.score.position,
          shownOldPosition(m.score.position, m.score.raw_position),
        ),
        rawPos: overallRawPos(m),
      })),
      ...unrostered.map((raw, i) => ({
        row: toUnrosteredRow(
          raw,
          unrosteredPositions[i],
          shownOldPosition(unrosteredPositions[i], unrosteredRawPos(raw)),
        ),
        rawPos: unrosteredRawPos(raw),
      })),
    ].sort((a, b) => a.rawPos - b.rawPos);

    overall.set(raceNumber, [
      ...rankedAndUnrostered.map((r) => r.row),
      ...unranked.map((m) => toRow(m.score, m.driver, m.raw, null, null)),
    ]);
  }

  const result: RoundResults = { byClass, overall, penalties };
  return finalShown && penalties.length > 0 ? applyPenaltyDisplay(result) : result;
}

/**
 * Margins, intervals and overall race times once this round's penalties
 * are added, for every race a visible penalty touches. Positions and
 * points already come from the view; this only changes display text, with
 * the same inputs and formula the results page has always used.
 */
export function applyPenaltyDisplay(results: RoundResults): RoundResults {
  const penaltyByRaceDriver = timePenaltiesByRaceDriver(results.penalties);
  const toGapInput = (r: RaceResultRow) => ({
    id: r.driver.id,
    intervalTenThousandths: r.intervalTenThousandths,
    lapsComplete: r.laps,
    averageLapTenThousandths: r.averageLapTenThousandths,
  });

  function redisplay(
    rows: RaceResultRow[],
    raceNumber: number,
    leader: RaceResultRow | undefined,
  ): RaceResultRow[] {
    const penaltyOf = (id: string) => penaltyByRaceDriver.get(`${raceNumber}:${id}`);
    const gaps = penalisedGaps(
      rows.filter((r) => r.position !== null).map(toGapInput),
      (id) => (penaltyOf(id) ?? 0) * 10000,
      {
        lapsComplete: leader?.laps ?? null,
        averageLapTenThousandths: leader?.averageLapTenThousandths ?? null,
      },
    );
    return rows.map((r) => {
      const gap = gaps.get(r.driver.id);
      const penaltySeconds = penaltyOf(r.driver.id);
      // Only a driver's own penalty changes their race time.
      const raceTime =
        penaltySeconds === undefined || r.overallRaceTimeTenThousandths === null
          ? null
          : overallRaceTimeTenThousandths(r.laps, r.averageLapTenThousandths, penaltySeconds);
      return {
        ...r,
        margin: (gap && penalisedMargin(gap)) ?? r.margin,
        intervalTenThousandths: gap
          ? (penalisedInterval(gap) ?? r.intervalTenThousandths)
          : r.intervalTenThousandths,
        overallRaceTimeTenThousandths: raceTime ?? r.overallRaceTimeTenThousandths,
        overallRaceTimeFormatted: raceTime === null ? r.overallRaceTimeFormatted : formatRaceTime(raceTime),
        hasPenalty: penaltySeconds !== undefined,
      };
    });
  }

  const overall = new Map(results.overall);
  const byClass = new Map(
    [...results.byClass].map(([classId, byRace]) => [classId, new Map(byRace)] as const),
  );
  for (const [raceNumber, rows] of results.overall) {
    if (!rows.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driver.id}`))) continue;
    // Laps down count from the race's on-track leader, before any penalty.
    overall.set(
      raceNumber,
      redisplay(
        rows,
        raceNumber,
        rows.find((r) => r.finishPosition === 1),
      ),
    );
    for (const [classId, byRace] of results.byClass) {
      const classRows = byRace.get(raceNumber);
      if (!classRows) continue;
      // The Per Class view measures from the class's own leader before penalties.
      const classLeader = classRows.find((r) => (r.penaltyOldPosition ?? r.position) === 1);
      byClass.get(classId)!.set(raceNumber, redisplay(classRows, raceNumber, classLeader));
    }
  }
  return { byClass, overall, penalties: results.penalties };
}
