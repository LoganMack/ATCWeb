import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getScoringRulesets, resolveSeasonRuleset, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions, type Penalty } from '../db/penalties';
import {
  displayDriverName,
  getCircuits,
  getAllCircuitLayouts,
  type Circuit,
  type CircuitLayout,
} from '../db/circuits';
import {
  reorderByTimePenalty,
  sumPenaltiesByRaceDriver,
  scoringRaceNumber,
  type LeaderRaceStats,
  type Positionable,
} from '../penalties/reorder';
import { isDecidedChampionshipSeason } from './shared';
import {
  driversSelect,
  getRaceScoresForSeasonsBulk,
  resultKey,
  type DriverBasic,
  type RaceScoreOverallRow,
} from './rows';
import { buildSeasonOverallContext, type SeasonOverallContext } from './seasonContext';
import { computeOverallSeasonStandings } from './standings';
import {
  getCuratedRaceResultsWithLapStatsBulk,
  getSeasonDriverExtendedStats,
  type DriverSeasonExtendedStats,
} from './extendedStats';
import { resolveLayout } from './layouts';
import { getRoundLayoutsForSubsessions } from './layoutLaps';
import { getAllRounds } from './rounds';

// ---------------------------------------------------------------------------
// Season awards (History > Awards tab) — twelve season-scoped honors, one
// winner per season. Confirmed with Logan:
//
// - Every award compares the WHOLE FIELD as one pool, not split by class —
//   "the class moniker is totally based on skill, the drivers all actually
//   are on a level playing field car-wise." Points-based awards therefore
//   reuse the same class-blind points formula `computeOverallSeasonStandings`
//   already uses for the site's own "Overall" competition (finish_points +
//   finesse_bonus + pole_bonus + points_deduction, class_points excluded —
//   that field is Gamma/Delta's own per-race bonus, not something every
//   driver can earn). Dominator/Defender are the one deliberate exception —
//   a "class winning margin" is inherently about winning your OWN class, so
//   those two alone still rank within each class, per race.
// - Rookie of the Season eligibility is reconstructed the same way
//   `sync_rookie_status()` (0041_driver_settings.sql) itself works, rather
//   than reading the live (present-day) `is_rookie` flag: a driver counts as
//   a rookie for season S if they had NOT yet had a season with 3+
//   appearances in any season strictly before S. That mirrors the real
//   rule's own "flips true -> false, permanently, the season you hit 3+
//   appearances" logic — a driver can be a rookie candidate across more than
//   one early low-participation season, and stops being one for good the
//   season they finally cross the threshold.
// - Ironman's "max distance possible that season" is: for each race the
//   season actually ran, whoever (any driver, any class) completed the most
//   laps in THAT race, times that round's own layout length — summed across
//   every race of the season. Not the class-winner's or race-winner's own
//   laps specifically, just the single furthest any entrant actually got.
// - Speed Demon's "fastest lap" is one race-wide bragging right per race
//   (not one per class) — ties (to the ten-thousandth of a second) credit
//   every driver who shares it, though that's vanishingly rare in practice.
// - Any award is SHARED on a tie — every award below picks the single best
//   VALUE, then collects every driver (Dominator/Defender: every race) that
//   actually hit it, rather than arbitrarily crowning one. Genuinely rare
//   for the points/stat-total awards, but a real possibility for something
//   like Speed Demon (an exact tie to the ten-thousandth) or a Dominator/
//   Defender margin.
// ---------------------------------------------------------------------------

/** One or more drivers, tied for this award's value — see this section's own doc comment on why ties are shared rather than arbitrarily broken. */
export interface SeasonAwardWinner {
  drivers: DriverBasic[];
  value: number;
}

/** Ironman — carries the season-wide distance ceiling alongside the winner(s)' own total. */
export interface SeasonIronmanWinner extends SeasonAwardWinner {
  maxPossibleKm: number;
}

/** Dominator/Defender — each tied instance is its own (driver, race) pair, since a tie there can span different races (even different drivers) that happened to produce the exact same margin — there's no single shared "the race" once more than one entry ties. */
export interface SeasonMarginAwardEntry {
  driver: DriverBasic;
  subsessionId: number;
  raceNumber: number;
  trackName: string;
}

export interface SeasonMarginAwardWinner {
  value: number;
  entries: SeasonMarginAwardEntry[];
}

export interface SeasonAwards {
  season: Season;
  rookieOfTheSeason: SeasonAwardWinner | null;
  sublimeFinesse: SeasonAwardWinner | null;
  leader: SeasonAwardWinner | null;
  ironman: SeasonIronmanWinner | null;
  consistency: SeasonAwardWinner | null;
  bonusFeature: SeasonAwardWinner | null;
  nakedAggression: SeasonAwardWinner | null;
  speedDemon: SeasonAwardWinner | null;
  dominator: SeasonMarginAwardWinner | null;
  defender: SeasonMarginAwardWinner | null;
  enduranceSpecialist: SeasonAwardWinner | null;
  sprintSpecialist: SeasonAwardWinner | null;
}

/** Alphabetical-by-display-name, for presenting a tied group of winners in a stable order. */
function sortDriversByName(driverIds: string[], driverById: Map<string, DriverBasic>): DriverBasic[] {
  return driverIds
    .map((id) => driverById.get(id)!)
    .sort((a, b) => displayDriverName(a.name).localeCompare(displayDriverName(b.name)));
}

/** Picks the single best VALUE straight off `DriverSeasonExtendedStats` and returns every driver tied at it (see this section's own doc comment on shared ties) — covers Sublime Finesse, Leader, Ironman's own total, Bonus Feature, and Naked Aggression, all of which are already computed there per driver per season. */
function pickBestFromExtendedStats(
  extendedStats: Map<string, DriverSeasonExtendedStats>,
  driverById: Map<string, DriverBasic>,
  valueOf: (s: DriverSeasonExtendedStats) => number | null,
  filter?: (driverId: string, s: DriverSeasonExtendedStats) => boolean,
): SeasonAwardWinner | null {
  let bestValue: number | null = null;
  let bestDriverIds: string[] = [];
  for (const [driverId, stats] of extendedStats) {
    if (!driverById.has(driverId)) continue;
    if (filter && !filter(driverId, stats)) continue;
    const value = valueOf(stats);
    if (value === null) continue;
    if (bestValue === null || value > bestValue) {
      bestValue = value;
      bestDriverIds = [driverId];
    } else if (value === bestValue) {
      bestDriverIds.push(driverId);
    }
  }
  return bestValue === null
    ? null
    : { drivers: sortDriversByName(bestDriverIds, driverById), value: bestValue };
}

/** Picks the single best VALUE out of a plain driverId -> total-value map and returns every driver tied at it — covers Speed Demon's fastest-lap tally, Consistency's average finish, and Endurance/Sprint Specialist's round-restricted point totals. */
function pickBestFromValueMap(
  values: Map<string, number>,
  driverById: Map<string, DriverBasic>,
  direction: 'max' | 'min' = 'max',
): SeasonAwardWinner | null {
  let bestValue: number | null = null;
  let bestDriverIds: string[] = [];
  for (const [driverId, value] of values) {
    if (!driverById.has(driverId)) continue;
    if (bestValue === null || (direction === 'max' ? value > bestValue : value < bestValue)) {
      bestValue = value;
      bestDriverIds = [driverId];
    } else if (value === bestValue) {
      bestDriverIds.push(driverId);
    }
  }
  return bestValue === null
    ? null
    : { drivers: sortDriversByName(bestDriverIds, driverById), value: bestValue };
}

/**
 * For each race the season actually ran, the most laps ANY entrant (any
 * class) completed times that round's own resolved layout length — summed
 * across the whole season. See this section's own doc comment for why this,
 * not the class/race winner's own laps specifically, is "max distance
 * possible."
 */
function computeMaxPossibleDistanceKm(
  overallContext: SeasonOverallContext,
  circuits: Circuit[],
  layouts: CircuitLayout[],
  roundLayouts: Map<number, string | null>,
): number {
  const trackNameBySubsession = new Map(
    overallContext.seasonRounds.map((r) => [r.subsession_id, r.track_name]),
  );
  const maxLapsByRace = new Map<string, number>();
  for (const s of overallContext.overallScores) {
    const custId = overallContext.custIdByDriverId.get(s.driver_id);
    const raw =
      custId != null
        ? overallContext.rawByKey.get(resultKey(s.subsession_id, s.race_number, custId))
        : undefined;
    const laps = raw?.laps_complete ?? 0;
    const key = `${s.subsession_id}:${s.race_number}`;
    if (laps > (maxLapsByRace.get(key) ?? 0)) maxLapsByRace.set(key, laps);
  }
  let total = 0;
  for (const [key, maxLaps] of maxLapsByRace) {
    const subsessionId = Number(key.split(':')[0]);
    const trackName = trackNameBySubsession.get(subsessionId);
    if (!trackName) continue;
    const layout = resolveLayout(trackName, roundLayouts.get(subsessionId) ?? null, circuits, layouts);
    if (layout?.length_km) total += maxLaps * layout.length_km;
  }
  return total;
}

/** This season's class-blind (finish + finesse + pole + deduction) points for one (subsession,race,driver) row — same formula `computeOverallSeasonStandings` uses. */
function overallPointsOfRow(s: RaceScoreOverallRow, overallContext: SeasonOverallContext): number {
  const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
  const adjustment = overallContext.adjustments.get(key);
  return adjustment
    ? adjustment.overallTotalPoints
    : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
}

/**
 * A round's Endurance/Sprint Specialist classification — its own
 * `curated_rounds.format` when set, otherwise (a "special event" round,
 * e.g. 0048_race_number_points_overrides.sql's per-race-table events) by
 * race count: more than one race in the round counts as a sprint round for
 * this, exactly one race counts as endurance (Logan's own rule).
 */
function classifyRoundForSpecialistAwards(
  subsessionId: number,
  overallContext: SeasonOverallContext,
  raceNumbersBySubsession: Map<number, Set<number>>,
): 'endurance' | 'sprint' {
  const explicit = overallContext.formatBySubsession.get(subsessionId);
  if (explicit === 'endurance' || explicit === 'sprint') return explicit;
  const raceCount = raceNumbersBySubsession.get(subsessionId)?.size ?? 1;
  return raceCount > 1 ? 'sprint' : 'endurance';
}

/**
 * Full history of all twelve season awards, newest season first (matching
 * `seasons`' own order — see `getSeasons`). Skips any season with no
 * race_scores data at all, same as `getChampions`. Bulk-fetches everything
 * once across every championship season (same "fetch once, slice in memory
 * per season" shape `getChampions`/`computeDriverCareerStats` already use)
 * rather than issuing each season's own round of queries — a from-scratch
 * per-season fetch here would multiply by every season on file and risk the
 * exact Cloudflare Workers subrequest-limit problem those functions' own
 * doc comments describe hitting before this same fix.
 */
export async function computeSeasonAwardsHistory(
  env: SupabaseEnv,
  seasons: Season[],
): Promise<SeasonAwards[]> {
  // isDecidedChampionshipSeason, not isChampionshipSeason alone — no awards
  // for a season still in progress, per Logan (same reasoning as
  // getChampions()'s own gate).
  const championshipSeasons = seasons.filter((s) => isDecidedChampionshipSeason(s));
  if (championshipSeasons.length === 0) return [];
  const championshipSeasonIds = championshipSeasons.map((s) => s.id);

  const [drivers, exhibitionIds, bulkScores, allRounds, rulesets, circuits, layouts] = await Promise.all([
    driversSelect(env),
    getStandingsExcludedRoundIds(env),
    getRaceScoresForSeasonsBulk(env, championshipSeasonIds),
    getAllRounds(env),
    getScoringRulesets(env),
    getCircuits(env).catch((err) => {
      console.error('Failed to fetch circuits for season awards — Ironman distance will be omitted:', err);
      return [] as Circuit[];
    }),
    getAllCircuitLayouts(env).catch((err) => {
      console.error(
        'Failed to fetch circuit_layouts for season awards — Ironman distance will be omitted:',
        err,
      );
      return [] as CircuitLayout[];
    }),
  ]);
  const driverById = new Map(drivers.map((d) => [d.id, d]));

  const allSubsessionIds = [...new Set(bulkScores.map((s) => s.subsession_id))];
  const [{ rawResults, lapStats }, penalties, roundLayouts] = await Promise.all([
    getCuratedRaceResultsWithLapStatsBulk(env, allSubsessionIds),
    getPenaltiesForSubsessions(env, allSubsessionIds),
    getRoundLayoutsForSubsessions(env, allSubsessionIds),
  ]);

  // --- Rookie-of-the-Season eligibility pre-pass, oldest season first ---
  // (independent of the main per-season loop below, which stays in
  // `seasons`' own newest-first order for the returned history).
  const championshipSeasonsAsc = [...championshipSeasons].sort((a, b) => a.number - b.number);
  const crossedThresholdSoFar = new Set<string>();
  const rookieCandidatesBySeasonId = new Map<string, Set<string>>();
  for (const season of championshipSeasonsAsc) {
    const seasonScores = bulkScores.filter(
      (s) => s.season_id === season.id && !exhibitionIds.has(s.subsession_id),
    );
    const appearancesByDriver = new Map<string, Set<number>>();
    for (const s of seasonScores) {
      if (!appearancesByDriver.has(s.driver_id)) appearancesByDriver.set(s.driver_id, new Set());
      appearancesByDriver.get(s.driver_id)!.add(s.subsession_id);
    }
    const candidates = new Set<string>();
    for (const driverId of appearancesByDriver.keys()) {
      if (!crossedThresholdSoFar.has(driverId)) candidates.add(driverId);
    }
    rookieCandidatesBySeasonId.set(season.id, candidates);
    for (const [driverId, subsessionIds] of appearancesByDriver) {
      if (subsessionIds.size >= 3) crossedThresholdSoFar.add(driverId);
    }
  }

  // --- Main per-season pass, `seasons`' own (newest-first) order ---
  const perSeason = await Promise.all(
    championshipSeasons.map(async (season) => {
      const seasonScores = bulkScores.filter((s) => s.season_id === season.id);
      if (seasonScores.length === 0) return null;
      const seasonSubsessionIds = new Set(seasonScores.map((s) => s.subsession_id));
      const seasonRawResults = rawResults.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonPenalties = penalties.filter((p) => seasonSubsessionIds.has(p.subsession_id));
      const seasonLapStats = lapStats.filter((r) => seasonSubsessionIds.has(r.subsession_id));
      const seasonRoundsList = allRounds.filter((r) => r.season_id === season.id);

      const overallContext = buildSeasonOverallContext(
        exhibitionIds,
        drivers,
        seasonScores,
        seasonRawResults,
        seasonPenalties,
        seasonRoundsList,
        seasonLapStats,
        resolveSeasonRuleset(season, rulesets)?.rules ?? null,
      );
      if (overallContext.overallScores.length === 0) return null;

      const [overallStandings, extendedStats] = await Promise.all([
        computeOverallSeasonStandings(env, season, drivers, exhibitionIds, overallContext, rulesets),
        getSeasonDriverExtendedStats(
          env,
          season,
          exhibitionIds,
          drivers,
          overallContext,
          circuits,
          layouts,
          roundLayouts,
        ),
      ]);

      // Rookie of the Season — highest season points (with drops, matching
      // the real standings) among drivers still rookie-eligible entering
      // this season (see the pre-pass above).
      const rookieCandidates = rookieCandidatesBySeasonId.get(season.id) ?? new Set<string>();
      let rookieBestPoints: number | null = null;
      let rookieBestDriverIds: string[] = [];
      for (const standing of overallStandings) {
        if (!rookieCandidates.has(standing.driver.id)) continue;
        if (rookieBestPoints === null || standing.totalPoints > rookieBestPoints) {
          rookieBestPoints = standing.totalPoints;
          rookieBestDriverIds = [standing.driver.id];
        } else if (standing.totalPoints === rookieBestPoints) {
          rookieBestDriverIds.push(standing.driver.id);
        }
      }
      const rookieOfTheSeason: SeasonAwardWinner | null =
        rookieBestPoints === null
          ? null
          : { drivers: sortDriversByName(rookieBestDriverIds, driverById), value: rookieBestPoints };

      // Sublime Finesse — corners per incident, minimum 50% of the season's
      // rounds attended (by appearances).
      const maxAppearances = new Set(overallContext.overallScores.map((s) => s.subsession_id)).size;
      const appearancesByDriverId = new Map(overallStandings.map((s) => [s.driver.id, s.appearances]));
      const sublimeFinesse = pickBestFromExtendedStats(
        extendedStats,
        driverById,
        (s) => s.cornersPerIncident,
        (driverId) => {
          const appearances = appearancesByDriverId.get(driverId) ?? 0;
          return maxAppearances > 0 && appearances * 2 >= maxAppearances;
        },
      );

      const leader = pickBestFromExtendedStats(extendedStats, driverById, (s) => s.lapsLed);
      const bonusFeature = pickBestFromExtendedStats(extendedStats, driverById, (s) => s.bonusPoints);
      const nakedAggression = pickBestFromExtendedStats(
        extendedStats,
        driverById,
        (s) => s.netPositionsChange,
      );

      const ironmanBest = pickBestFromExtendedStats(extendedStats, driverById, (s) => s.distanceKm);
      const ironman: SeasonIronmanWinner | null = ironmanBest
        ? {
            ...ironmanBest,
            maxPossibleKm: computeMaxPossibleDistanceKm(overallContext, circuits, layouts, roundLayouts),
          }
        : null;

      // Consistency — best (lowest) average overall finish position per
      // race, same minimum-50%-of-the-season's-rounds-attended (by
      // appearances) gate as Sublime Finesse — otherwise a driver who
      // showed up once and had a great day could win this outright.
      const consistencyAccum = new Map<string, { sum: number; count: number }>();
      for (const s of overallContext.overallScores) {
        if (s.dsq) continue;
        const key = `${s.subsession_id}:${s.race_number}:${s.driver_id}`;
        const adjustment = overallContext.adjustments.get(key);
        const position = adjustment ? adjustment.newPosition : s.scored_position;
        if (position === null) continue;
        const a = consistencyAccum.get(s.driver_id) ?? { sum: 0, count: 0 };
        a.sum += position;
        a.count += 1;
        consistencyAccum.set(s.driver_id, a);
      }
      const consistencyAverages = new Map<string, number>();
      for (const [driverId, a] of consistencyAccum) {
        if (a.count === 0) continue;
        const appearances = appearancesByDriverId.get(driverId) ?? 0;
        if (maxAppearances > 0 && appearances * 2 >= maxAppearances) {
          consistencyAverages.set(driverId, a.sum / a.count);
        }
      }
      const consistency = pickBestFromValueMap(consistencyAverages, driverById, 'min');

      // Speed Demon — most races with the single fastest lap of the whole
      // field (every class together — see this section's doc comment).
      const raceGroupsAll = new Map<string, RaceScoreOverallRow[]>();
      for (const s of overallContext.overallScores) {
        const key = `${s.subsession_id}:${s.race_number}`;
        if (!raceGroupsAll.has(key)) raceGroupsAll.set(key, []);
        raceGroupsAll.get(key)!.push(s);
      }
      const fastestLapCounts = new Map<string, number>();
      for (const group of raceGroupsAll.values()) {
        let bestTime: number | null = null;
        let bestDriverIds: string[] = [];
        for (const s of group) {
          if (s.dsq) continue;
          const custId = overallContext.custIdByDriverId.get(s.driver_id);
          const lapStatsRow =
            custId != null
              ? overallContext.lapStatsByKey.get(resultKey(s.subsession_id, s.race_number, custId))
              : undefined;
          const t = lapStatsRow?.best_lap_ten_thousandths ?? null;
          if (t === null) continue;
          if (bestTime === null || t < bestTime) {
            bestTime = t;
            bestDriverIds = [s.driver_id];
          } else if (t === bestTime) {
            bestDriverIds.push(s.driver_id);
          }
        }
        for (const driverId of bestDriverIds) {
          fastestLapCounts.set(driverId, (fastestLapCounts.get(driverId) ?? 0) + 1);
        }
      }
      const speedDemon = pickBestFromValueMap(fastestLapCounts, driverById, 'max');

      // Dominator/Defender — biggest/smallest class-winning margin of any
      // single race this season (not a season total — see doc comment).
      //
      // Penalty-aware: for any race a penalty actually touched (for one of
      // THIS class's own drivers — a penalty against a different class in
      // the same race never changes this class's own order/margin), the
      // class's top two are re-ranked/re-gapped the exact same way the round
      // results page and the season standings views do it
      // (reorderByTimePenalty — see src/lib/penalties.ts's Position
      // recalculation header), rather than reading the raw pre-penalty
      // finish order straight off curated_race_results. That used to be a
      // real gap: a penalty that swapped a class's top two (or changed the
      // gap between them) never showed up here, per Logan. Untouched races
      // keep reading raw pipeline data directly — reordering with an
      // all-zero penalty map isn't guaranteed byte-identical to the
      // original sort (ties/pipeline quirks), same reasoning
      // computeSeasonOverallAdjustments itself documents for skipping
      // untouched races.
      const classRaceGroups = new Map<string, RaceScoreOverallRow[]>();
      for (const s of overallContext.overallScores) {
        const key = `${s.subsession_id}:${s.race_number}:${s.class_id}`;
        if (!classRaceGroups.has(key)) classRaceGroups.set(key, []);
        classRaceGroups.get(key)!.push(s);
      }
      const trackNameBySubsession = new Map(
        overallContext.seasonRounds.map((r) => [r.subsession_id, r.track_name]),
      );

      // Penalties grouped by (subsessionId:scoringRaceNumber) — same
      // shape/reasoning as computeSeasonOverallAdjustments' own
      // penaltiesByRace, so sumPenaltiesByRaceDriver (keyed only by
      // raceNumber, not subsessionId) never collides across two different
      // rounds that happen to share a race number.
      const marginRaceKey = (subsessionId: number, raceNumber: number) => `${subsessionId}:${raceNumber}`;
      const penaltiesByMarginRace = new Map<string, Penalty[]>();
      for (const p of overallContext.penalties) {
        const key = marginRaceKey(p.subsession_id, scoringRaceNumber(p));
        if (!penaltiesByMarginRace.has(key)) penaltiesByMarginRace.set(key, []);
        penaltiesByMarginRace.get(key)!.push(p);
      }

      interface MarginObservation {
        driverId: string;
        margin: number;
        subsessionId: number;
        raceNumber: number;
        trackName: string;
      }
      const marginObservations: MarginObservation[] = [];
      for (const [key, group] of classRaceGroups) {
        const [subsessionIdStr, raceNumberStr] = key.split(':');
        const subsessionId = Number(subsessionIdStr);
        const raceNumber = Number(raceNumberStr);

        const positionable: Positionable[] = group
          .filter((s) => !s.dsq)
          .map((s) => {
            const custId = overallContext.custIdByDriverId.get(s.driver_id);
            const raw =
              custId != null
                ? overallContext.rawByKey.get(resultKey(subsessionId, raceNumber, custId))
                : undefined;
            const lapStatsRow =
              custId != null
                ? overallContext.lapStatsByKey.get(resultKey(subsessionId, raceNumber, custId))
                : undefined;
            return {
              driverId: s.driver_id,
              position: raw?.adjusted_position ?? raw?.finish_position ?? null,
              intervalTenThousandths: raw?.interval_ten_thousandths ?? null,
              lapsComplete: raw?.laps_complete ?? null,
              averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
            };
          })
          .filter((r) => r.position !== null);
        if (positionable.length < 2) continue;

        const racePenalties = penaltiesByMarginRace.get(marginRaceKey(subsessionId, raceNumber)) ?? [];
        const penaltyByRaceDriver = sumPenaltiesByRaceDriver(
          racePenalties.map((p) => ({ ...p, race_number: raceNumber })),
        );
        const touched = positionable.some((r) => penaltyByRaceDriver.has(`${raceNumber}:${r.driverId}`));

        let p1DriverId: string | null = null;
        let margin: number | null = null;

        if (touched) {
          const leader: LeaderRaceStats = overallContext.leaderStatsByRace.get(
            marginRaceKey(subsessionId, raceNumber),
          ) ?? {
            lapsComplete: null,
            averageLapTenThousandths: null,
          };
          const ranked = reorderByTimePenalty(positionable, raceNumber, penaltyByRaceDriver, leader);
          // Only the lead-lap group (lapsDown === 0) has a real, comparable
          // time gap — same "usable margin" gate the untouched branch below
          // applies to the raw interval. gapTenThousandths is already
          // re-zeroed against whichever row is actually smallest now (see
          // RankedPosition's own doc comment), so the class winner always
          // reads exactly 0 here.
          const leadLapRanked = [...ranked.entries()]
            .filter(([, r]) => r.lapsDown === 0 && r.gapTenThousandths !== null)
            .sort((a, b) => (a[1].gapTenThousandths as number) - (b[1].gapTenThousandths as number));
          if (leadLapRanked.length >= 2) {
            const [[id1, r1], [, r2]] = leadLapRanked;
            p1DriverId = id1;
            margin = (r2.gapTenThousandths as number) - (r1.gapTenThousandths as number);
          }
        } else {
          const ranked = [...positionable].sort((a, b) => (a.position as number) - (b.position as number));
          const [rp1, rp2] = ranked;
          // Only a real, usable time gap for both (a negative interval means
          // "a lap or more down," not a real gap — see `formatMargin`) counts
          // as a margin here; anything else is skipped rather than guessed at.
          if (
            rp1.intervalTenThousandths !== null &&
            rp2.intervalTenThousandths !== null &&
            rp1.intervalTenThousandths >= 0 &&
            rp2.intervalTenThousandths >= 0
          ) {
            const m = rp2.intervalTenThousandths - rp1.intervalTenThousandths;
            if (m >= 0) {
              p1DriverId = rp1.driverId;
              margin = m;
            }
          }
        }

        if (p1DriverId === null || margin === null || margin < 0 || !driverById.has(p1DriverId)) continue;
        marginObservations.push({
          driverId: p1DriverId,
          margin,
          subsessionId,
          raceNumber,
          trackName: trackNameBySubsession.get(subsessionId) ?? 'Unknown',
        });
      }
      // Shared ties: collect every (driver, race) observation whose margin
      // exactly matches the season's biggest/smallest, not just the first
      // one encountered — a tie here can span different races (even
      // different drivers), so there's no single "the" race once more than
      // one observation ties (see SeasonMarginAwardWinner's own comment).
      let dominator: SeasonMarginAwardWinner | null = null;
      let defender: SeasonMarginAwardWinner | null = null;
      if (marginObservations.length > 0) {
        const maxMargin = Math.max(...marginObservations.map((o) => o.margin));
        const minMargin = Math.min(...marginObservations.map((o) => o.margin));
        const entriesAt = (margin: number): SeasonMarginAwardEntry[] =>
          marginObservations
            .filter((o) => o.margin === margin)
            .map((o) => ({
              driver: driverById.get(o.driverId)!,
              subsessionId: o.subsessionId,
              raceNumber: o.raceNumber,
              trackName: o.trackName,
            }))
            .sort((a, b) => displayDriverName(a.driver.name).localeCompare(displayDriverName(b.driver.name)));
        dominator = { value: maxMargin, entries: entriesAt(maxMargin) };
        defender = { value: minMargin, entries: entriesAt(minMargin) };
      }

      // Endurance/Sprint Specialist — class-blind points, restricted to one
      // round type, no drop weeks at all (unlike every other points-based
      // figure on this page).
      const raceNumbersBySubsession = new Map<number, Set<number>>();
      for (const s of overallContext.overallScores) {
        if (!raceNumbersBySubsession.has(s.subsession_id))
          raceNumbersBySubsession.set(s.subsession_id, new Set());
        raceNumbersBySubsession.get(s.subsession_id)!.add(s.race_number);
      }
      const endurancePoints = new Map<string, number>();
      const sprintPoints = new Map<string, number>();
      for (const s of overallContext.overallScores) {
        const points = overallPointsOfRow(s, overallContext);
        const bucket =
          classifyRoundForSpecialistAwards(s.subsession_id, overallContext, raceNumbersBySubsession) ===
          'endurance'
            ? endurancePoints
            : sprintPoints;
        bucket.set(s.driver_id, (bucket.get(s.driver_id) ?? 0) + points);
      }
      const enduranceSpecialist = pickBestFromValueMap(endurancePoints, driverById, 'max');
      const sprintSpecialist = pickBestFromValueMap(sprintPoints, driverById, 'max');

      const awards: SeasonAwards = {
        season,
        rookieOfTheSeason,
        sublimeFinesse,
        leader,
        ironman,
        consistency,
        bonusFeature,
        nakedAggression,
        speedDemon,
        dominator,
        defender,
        enduranceSpecialist,
        sprintSpecialist,
      };
      return awards;
    }),
  );

  return perSeason.filter((r): r is SeasonAwards => r !== null);
}
