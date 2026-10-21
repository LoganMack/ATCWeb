import { restGet, type SupabaseEnv } from '../db/client';
import { getCarLogos } from '../db/assets';
import { formatLapTime } from '../db/circuits';
import {
  getCuratedRaceResultsForSubsessions,
  driversSelect,
  getTeamsBasic,
  getAllTeamSeasonLogosSafe,
  getLapStatsForSubsessions,
  getDisplayNamesForSubsessions,
  resultKey,
  buildSeasonLogoMap,
  resolveTeamLogo,
  type DriverBasic,
  type RaceScoreRow,
  type CuratedRaceResultRow,
} from './rows';
import { getRoundBySubsessionId } from './rounds';
import { formatMargin } from './format';

export interface RaceResultRow {
  raceNumber: number;
  classId: number;
  /**
   * null for a disqualified driver — they're listed but don't occupy a
   * position. In the per-class view this is the class-relative position
   * (re-derived from curated_race_results, see the file header); in the
   * overall view it's `race_scores.scored_position` as-is, since that
   * column already is the overall field position — and the points system
   * is based on overall finishing position, not class-relative position.
   */
  position: number | null;
  dsq: boolean;
  driver: DriverBasic;
  finishPosition: number;
  startingPosition: number | null;
  wasAdjusted: boolean;
  totalPoints: number;
  /**
   * `total_points` is a generated column: finish_points + class_points +
   * finesse_bonus + pole_bonus + points_deduction. finish_points (the base
   * overall-position points) isn't broken out separately since it's most
   * of the total for every driver — everything else (class_points,
   * finesse_bonus, pole_bonus, points_deduction) is combined into one
   * "bonus points" figure shown under the Points total, and only when
   * nonzero.
   */
  bonusPoints: number;
  /**
   * `totalPoints` exactly as the pipeline/race_scores originally computed
   * it, before any penalty — this driver's own, or a cascade from someone
   * else's in the same race — was applied. `src/lib/penalties.ts`'s
   * `recomputeRow` only ever overwrites `totalPoints` (and its components)
   * on the returned row, never this field, so `totalPoints -
   * originalTotalPoints` is always a clean "how many points did this
   * round's penalties net this driver" figure — 0 for a row nothing ever
   * touched. Shown in the results table's expanded detail panel (see
   * ResultsTable.astro).
   */
  originalTotalPoints: number;
  /** The individual components `bonusPoints` above is the sum of — broken out (rather than only ever combined) so src/lib/penalties.ts can recompute just classPoints/pointsDeduction when a penalty changes this driver's position or applies a flat points penalty, while leaving finesseBonus/poleBonus (unaffected by either kind of penalty) alone. */
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
   * General-purpose result tags, e.g. "Unclassified" (finished under 50% of
   * the leader's laps — driven by `race_scores.classified`, not re-derived
   * here). Deliberately a list rather than one string so a future tag (e.g.
   * a penalty) can sit alongside it — replaces the old single `reasonOut`
   * ("disconnected"-style) field, which added little value.
   */
  tags: string[];
  /**
   * Gap to the leader. Formatted "xx.xxx" (seconds) normally; "—" for the
   * leader themselves (a 0.000 gap) or when there's no interval on record;
   * "-xL" when the raw interval is negative, which iRacing uses to flag a
   * driver who finished one or more laps down (x = leader's laps_complete
   * minus this driver's) rather than a real time gap.
   *
   * "The leader" here means whichever leader this row's own view cares
   * about: the race's actual overall on-track leader for an Overall-view
   * row, or that row's own class leader for a Per Class-view (byClass) row
   * — the two are built as separate row objects (see getRoundResults'
   * byClass construction / applyPenaltiesToRoundResults' class-scoped
   * margin reorder in src/lib/penalties.ts), so the same driver's margin
   * can legitimately read differently in each view.
   */
  margin: string;
  /** The raw value `margin` above is formatted from (ten-thousandths of a second, negative = the "-xL" laps-down flag, relative to whichever leader `margin` itself is measured against — see its own doc comment) — kept around unformatted so src/lib/penalties.ts can numerically re-sort the field around a time penalty. */
  intervalTenThousandths: number | null;
  /** Set by applyPenaltiesToRoundResults() (src/lib/penalties.ts) when a time penalty (this driver's own, or another driver's that cascaded past them) moved this driver from a different position — the position they'd have had before this round's penalties, so the UI can show it struck through next to the new one. Null when unaffected. */
  penaltyOldPosition: number | null;
  /** True once any penalty — time, points, or PP-only — has been logged against this driver for this specific race. Independent of penaltyOldPosition (a PP-only or points-only penalty doesn't necessarily move their position). */
  hasPenalty: boolean;
  /** The team this driver raced for in this specific race (from `race_scores.team_id`), or null if unassigned. `logoUrl` is that team's logo AS OF this round's season (0019_team_season_logos.sql) when a historical override exists, otherwise the team's current logo. */
  team: { name: string; logoUrl: string | null } | null;
  /** The car this driver used for this specific race (`curated_race_results.car_name`), or null if not recorded. */
  car: { name: string; logoUrl: string | null } | null;
  /** "1:42.512"-formatted average lap the race (see `formatLapTime` in src/lib/supabase.ts), from `curated_race_results.average_lap_ten_thousandths` (isolated fetch, see getLapStatsForSubsessions) — "—" when the pipeline hasn't got this for this driver/race. */
  averageLapFormatted: string;
  /** Raw ten-thousandths-of-a-second value averageLapFormatted is formatted from — kept unformatted, same reasoning as intervalTenThousandths, so src/lib/penalties.ts can do exact integer math with it (rule 18.3.2's "own laps × own average lap" — see reorderByTimePenalty) rather than round-tripping through the display string. Null when there's no data. */
  averageLapTenThousandths: number | null;
  /** This driver's single fastest lap the race, formatted the same way. Same source/isolation as averageLapFormatted. */
  bestLapFormatted: string;
  /** Raw ten-thousandths-of-a-second value bestLapFormatted is formatted from — kept unformatted so callers can do numeric comparisons (e.g. against a driver's personal-best at this track, see getDriverBestLapsAtTrack) without round-tripping through the display string. Null when there's no data. */
  bestLapTenThousandths: number | null;
  /**
   * "Overall race time" — own laps × own average lap (rule 18.3.2's method
   * for comparing drivers who aren't on the lead lap, where the normal
   * leader-relative `margin` above isn't a real time gap; see
   * reorderByTimePenalty in src/lib/penalties.ts) — "—" whenever
   * averageLapTenThousandths is null. Reflects any time penalty already
   * added in — this is the driver's FINAL effective total, not their raw
   * pre-penalty time — recomputed by applyPenaltiesToRoundResults()
   * whenever this driver (or one that cascaded past them) was penalized.
   */
  overallRaceTimeFormatted: string;
  /** Raw ten-thousandths-of-a-second value overallRaceTimeFormatted is formatted from — same reasoning as averageLapTenThousandths. Null when there's no data to compute it from. */
  overallRaceTimeTenThousandths: number | null;
  /**
   * True for an entrant who actually raced this round (present in
   * curated_race_results, the raw results pipeline data) but has no
   * matching row in `drivers` at all — recalculate_race_scores() inner-
   * joins to `drivers`, so a cust_id with no roster entry never gets a
   * race_scores row and would otherwise vanish from this round's results
   * entirely (see toUnrosteredRow). Only ever true in the Overall view —
   * there's no way to know what class an unrostered entrant belongs to, so
   * they can't be placed in any per-class view. Never scored: every points
   * field above is 0 for this row and src/lib/penalties.ts's recomputeRow
   * deliberately never assigns them real points either, even if another
   * driver's penalty reshuffles them to a new position.
   */
  notInRoster: boolean;
}

export interface RoundResults {
  /** class_id -> race_number -> rows, ranked class-relative. */
  byClass: Map<number, Map<number, RaceResultRow[]>>;
  /** race_number -> rows (every class combined), ranked by overall field position. */
  overall: Map<number, RaceResultRow[]>;
}

type RaceScoreWithClass = RaceScoreRow & {
  class_id: number;
  team_id: string | null;
  scored_position: number | null;
  finish_points: number;
  class_points: number;
  finesse_bonus: number;
  points_deduction: number;
};

/**
 * Race-by-race results for one round, both grouped by class (ranked within
 * class, the same approach as `computeSeasonStandings`) and as a single
 * overall field per race (ranked by `race_scores.scored_position`, which the
 * points system itself is based on) — the results page lets visitors toggle
 * between the two.
 */
export async function getRoundResults(env: SupabaseEnv, subsessionId: number): Promise<RoundResults> {
  const select =
    'subsession_id,race_number,driver_id,class_id,team_id,finish_points,class_points,finesse_bonus,pole_bonus,points_deduction,aggression_bonus,lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,total_points,classified,dsq,scored_position';
  const [scores, rawResults, drivers, teams, carLogos, round, seasonLogoRows, lapStats, displayNames] =
    await Promise.all([
      restGet<RaceScoreWithClass[]>(
        env,
        `race_scores_public?select=${select}&subsession_id=eq.${subsessionId}`,
      ),
      getCuratedRaceResultsForSubsessions(env, [subsessionId]),
      driversSelect(env, { includeAi: true }),
      getTeamsBasic(env),
      getCarLogos(env),
      getRoundBySubsessionId(env, subsessionId),
      getAllTeamSeasonLogosSafe(env),
      getLapStatsForSubsessions(env, [subsessionId]),
      getDisplayNamesForSubsessions(env, [subsessionId]),
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
  // `formatMargin`. Also the leader's own average lap — src/lib/penalties.ts
  // uses it as the stand-in for "the leader's final lap pace" (rule 18.3.2
  // doesn't give us literal last-lap telemetry, only average-lap data) when
  // deciding whether a time penalty pushes someone an extra lap down.
  const leaderLapsByRace = new Map<number, number | null>();
  const leaderAverageLapByRace = new Map<number, number | null>();
  for (const r of rawResults) {
    if (r.finish_position === 1) {
      leaderLapsByRace.set(r.race_number, r.laps_complete);
      const custId = r.cust_id;
      leaderAverageLapByRace.set(
        r.race_number,
        lapStatsByKey.get(resultKey(r.subsession_id, r.race_number, custId))?.average_lap_ten_thousandths ??
          null,
      );
    }
  }

  function toRow(
    score: RaceScoreWithClass,
    driver: DriverBasic,
    raw: CuratedRaceResultRow,
    position: number | null,
    /**
     * When set, this row's margin is measured against THIS driver (the
     * class leader) instead of the race's overall on-track leader — used by
     * the byClass construction below so the Per Class view shows distance
     * to the class leader rather than distance to the overall winner. Left
     * unset for the Overall view's own toRow() calls, which keep measuring
     * against `leaderLapsByRace`/0 exactly as before.
     */
    classLeaderRaw: CuratedRaceResultRow | null = null,
  ): RaceResultRow {
    const team = score.team_id ? (teamById.get(score.team_id) ?? null) : null;
    const lapStatsRow = lapStatsByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id));
    const averageLapTenThousandths = lapStatsRow?.average_lap_ten_thousandths ?? null;
    const bestLapTenThousandths = lapStatsRow?.best_lap_ten_thousandths ?? null;
    const overallRaceTimeTenThousandths =
      averageLapTenThousandths !== null && raw.laps_complete !== null
        ? raw.laps_complete * averageLapTenThousandths
        : null;
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
      wasAdjusted: raw.adjusted_position !== null && raw.adjusted_position !== raw.finish_position,
      totalPoints: score.total_points,
      originalTotalPoints: score.total_points,
      bonusPoints:
        score.class_points +
        score.finesse_bonus +
        score.pole_bonus +
        score.aggression_bonus +
        score.lap_led_bonus +
        score.fewest_incidents_bonus +
        score.fastest_lap_bonus +
        score.sprint_sweep_bonus +
        score.points_deduction,
      classPoints: score.class_points,
      finesseBonus: score.finesse_bonus,
      poleBonus: score.pole_bonus,
      aggressionBonus: score.aggression_bonus,
      lapLedBonus: score.lap_led_bonus,
      fewestIncidentsBonus: score.fewest_incidents_bonus,
      fastestLapBonus: score.fastest_lap_bonus,
      sprintSweepBonus: score.sprint_sweep_bonus,
      pointsDeduction: score.points_deduction,
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
      margin: classLeaderRaw
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
          ),
      intervalTenThousandths: raw.interval_ten_thousandths,
      penaltyOldPosition: null,
      hasPenalty: false,
      team: team ? { name: team.name, logoUrl: resolveTeamLogo(team, seasonId, seasonLogoMap) } : null,
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
      notInRoster: false,
    };
  }

  /**
   * A row for an entrant who actually raced this round but has no matching
   * `drivers` row at all — see RaceResultRow.notInRoster's own doc comment
   * for the mechanism. Deliberately mirrors toRow() above wherever real data
   * exists for them (car, laps, margin, average/best lap all come straight
   * from the same raw pipeline row every scored driver's row is built from)
   * and zeroes out everything that would otherwise require a race_scores
   * row to exist (points, team, pole/finesse/aggression bonuses, class).
   */
  function toUnrosteredRow(raw: CuratedRaceResultRow, position: number | null): RaceResultRow {
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
      wasAdjusted: false,
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
      penaltyOldPosition: null,
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
    score: RaceScoreWithClass;
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

  // --- Per class: class-relative position, re-derived from curated_race_results ---
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
      const rawPos = (m: Matched) => m.raw.adjusted_position ?? m.raw.finish_position;
      // Disqualified drivers don't occupy a class position — everyone else
      // ranks as if they weren't there — but they're still listed, at the
      // bottom, so the results page shows the complete field.
      const ranked = group.filter((m) => !m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      const dsqd = group.filter((m) => m.score.dsq).sort((a, b) => rawPos(a) - rawPos(b));
      // The class leader (this class's own P1, pre-penalty) — every row in
      // this class/race is measured against them for margin display in the
      // Per Class view, rather than against the race's overall leader. Null
      // when the whole class is DSQ'd and there's no one to measure against
      // (falls back to toRow()'s usual overall-leader margin in that case).
      const classLeaderRaw = ranked.length > 0 ? ranked[0].raw : null;
      classOut.set(raceNumber, [
        ...ranked.map((m, i) => toRow(m.score, m.driver, m.raw, i + 1, classLeaderRaw)),
        ...dsqd.map((m) => toRow(m.score, m.driver, m.raw, null, classLeaderRaw)),
      ]);
    }
    byClass.set(classId, classOut);
  }

  // --- Overall: every class combined, ranked by race_scores.scored_position ---
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

  const overallRawPos = (m: Matched) => m.raw.adjusted_position ?? m.raw.finish_position;
  const unrosteredRawPos = (raw: CuratedRaceResultRow) => raw.adjusted_position ?? raw.finish_position;
  const overall = new Map<number, RaceResultRow[]>();
  const allRaceNumbers = new Set<number>([...byRaceAll.keys(), ...unmatchedByRace.keys()]);
  for (const raceNumber of allRaceNumbers) {
    const group = byRaceAll.get(raceNumber) ?? [];
    const unmatchedGroup = unmatchedByRace.get(raceNumber) ?? [];
    const ranked = group
      .filter((m) => !m.score.dsq && m.score.scored_position !== null)
      .sort((a, b) => (a.score.scored_position as number) - (b.score.scored_position as number));
    // Anything without a usable scored_position (unexpected, but the field
    // is nullable) falls back to the same raw-position sort used for DSQs,
    // and is shown without a position — consistent with the per-class view.
    const unranked = group
      .filter((m) => m.score.dsq || m.score.scored_position === null)
      .sort((a, b) => overallRawPos(a) - overallRawPos(b));

    // race_scores.scored_position IS the same raw finish/adjusted position
    // every entrant already has on curated_race_results (recalculate_race_
    // scores() carries it straight through, unrenumbered) — so an
    // unrostered entrant's raw position sorts correctly alongside everyone
    // else's scored_position with no re-derivation needed, keeping the
    // Overall view a complete, truthfully-ordered field instead of tacking
    // unrostered rows onto the end.
    const rankedAndUnrostered = [
      ...ranked.map((m) => ({
        row: toRow(m.score, m.driver, m.raw, m.score.scored_position),
        rawPos: overallRawPos(m),
      })),
      ...unmatchedGroup.map((raw) => ({
        row: toUnrosteredRow(raw, unrosteredRawPos(raw)),
        rawPos: unrosteredRawPos(raw),
      })),
    ].sort((a, b) => a.rawPos - b.rawPos);

    overall.set(raceNumber, [
      ...rankedAndUnrostered.map((r) => r.row),
      ...unranked.map((m) => toRow(m.score, m.driver, m.raw, null)),
    ]);
  }

  return { byClass, overall };
}
