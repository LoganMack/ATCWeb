import type { SupabaseEnv } from '../db/client';
import { getStandingsExcludedRoundIds } from '../db/rounds';
import { getScoringRulesets, type Season } from '../db/seasons';
import { getPenaltiesForSubsessions } from '../db/penalties';
import {
  displayDriverName,
  getCircuits,
  getAllCircuitLayouts,
  type Circuit,
  type CircuitLayout,
} from '../db/circuits';
import { isDecidedChampionshipSeason } from './shared';
import {
  driversSelect,
  getRaceScoresForSeasonsBulk,
  resultKey,
  type DriverBasic,
  type ScoreRow,
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
import { penalisedGaps, timePenaltiesByRaceDriver, type LeaderLap } from './raceDisplay';
import { getAllRounds } from './rounds';

// Season awards (History > Awards): twelve season-scoped honors, rules confirmed with Logan.
// - Every award pools the whole field (classes are skill tiers, not car tiers), so points awards use the
//   class-blind `overall_total`; Dominator/Defender alone rank within each class, per race.
// - Rookie eligibility is rebuilt per season the way `sync_rookie_status()` works (no earlier season with
//   3+ appearances), not read from today's `is_rookie`.
// - Ironman's possible distance sums, per race, the most laps any entrant completed times the layout
//   length.
// - Ties are shared: each award takes the best value and credits every driver (or race) that hit it.

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
 * Per race, the most laps any entrant completed times the layout length, summed over the season: the "max
 * distance possible" for Ironman.
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

/**
 * A round's Endurance/Sprint Specialist class: its `curated_rounds.format`, or for a special-event round, one
 * race = endurance and more = sprint (Logan's rule).
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
 * All twelve season awards, newest season first; seasons with no results are skipped. Everything is
 * bulk-fetched once and sliced per season in memory, because per-season queries exceed the Workers subrequest
 * limit.
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

      // Consistency: best average overall finish, with the same 50%-of-rounds attendance gate as Sublime
      // Finesse so one great race can't win it.
      const consistencyAccum = new Map<string, { sum: number; count: number }>();
      for (const s of overallContext.overallScores) {
        if (s.dsq) continue;
        const position = s.position;
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
      const raceGroupsAll = new Map<string, ScoreRow[]>();
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

      // Dominator/Defender: biggest/smallest class-winning margin of a single race. When a penalty touched
      // this class in a race, the gaps include time penalties re-zeroed to the new winner, as on the results
      // page (raceDisplay.ts).
      const classRaceGroups = new Map<string, ScoreRow[]>();
      for (const s of overallContext.overallScores) {
        const key = `${s.subsession_id}:${s.race_number}:${s.class_id}`;
        if (!classRaceGroups.has(key)) classRaceGroups.set(key, []);
        classRaceGroups.get(key)!.push(s);
      }
      const trackNameBySubsession = new Map(
        overallContext.seasonRounds.map((r) => [r.subsession_id, r.track_name]),
      );
      // The race's on-track leader (finish_position 1), the reference laps down are counted from.
      const leaderByRace = new Map<string, LeaderLap>();
      for (const raw of overallContext.rawByKey.values()) {
        if (raw.finish_position !== 1) continue;
        leaderByRace.set(`${raw.subsession_id}:${raw.race_number}`, {
          lapsComplete: raw.laps_complete,
          averageLapTenThousandths:
            overallContext.lapStatsByKey.get(resultKey(raw.subsession_id, raw.race_number, raw.cust_id))
              ?.average_lap_ten_thousandths ?? null,
        });
      }
      // subsession -> race:driver -> effective time penalty, from the penalties this reader may see.
      const penaltiesBySubsession = new Map<number, Map<string, number>>();
      const penaltyListBySubsession = new Map<number, typeof overallContext.penalties>();
      for (const p of overallContext.penalties) {
        if (!penaltyListBySubsession.has(p.subsession_id)) penaltyListBySubsession.set(p.subsession_id, []);
        penaltyListBySubsession.get(p.subsession_id)!.push(p);
      }
      for (const [id, list] of penaltyListBySubsession) penaltiesBySubsession.set(id, timePenaltiesByRaceDriver(list));

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

        const field = group
          .filter((s) => !s.dsq)
          .map((s) => {
            const custId = overallContext.custIdByDriverId.get(s.driver_id);
            const raw =
              custId != null ? overallContext.rawByKey.get(resultKey(subsessionId, raceNumber, custId)) : undefined;
            const lapStatsRow =
              custId != null ? overallContext.lapStatsByKey.get(resultKey(subsessionId, raceNumber, custId)) : undefined;
            return {
              id: s.driver_id,
              position: raw?.adjusted_position ?? raw?.finish_position ?? null,
              intervalTenThousandths: raw?.interval_ten_thousandths ?? null,
              lapsComplete: raw?.laps_complete ?? null,
              averageLapTenThousandths: lapStatsRow?.average_lap_ten_thousandths ?? null,
            };
          })
          .filter((r) => r.position !== null);
        if (field.length < 2) continue;

        const racePenalties = penaltiesBySubsession.get(subsessionId) ?? new Map<string, number>();
        const penaltyOf = (id: string) => racePenalties.get(`${raceNumber}:${id}`);
        const touched = field.some((r) => penaltyOf(r.id) !== undefined);

        let p1DriverId: string | null = null;
        let margin: number | null = null;

        if (touched) {
          const gaps = penalisedGaps(field, (id) => (penaltyOf(id) ?? 0) * 10000, leaderByRace.get(`${subsessionId}:${raceNumber}`) ?? {
            lapsComplete: null,
            averageLapTenThousandths: null,
          });
          // Only the lead-lap group has a real, comparable time gap; the class
          // winner reads exactly 0 after re-zeroing.
          const leadLap = [...gaps.entries()]
            .filter(([, g]) => g.lapsDown === 0 && g.gapTenThousandths !== null)
            .sort((a, b) => (a[1].gapTenThousandths as number) - (b[1].gapTenThousandths as number));
          if (leadLap.length >= 2) {
            const [[id1, g1], [, g2]] = leadLap;
            p1DriverId = id1;
            margin = (g2.gapTenThousandths as number) - (g1.gapTenThousandths as number);
          }
        } else {
          const ranked = [...field].sort((a, b) => (a.position as number) - (b.position as number));
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
              p1DriverId = rp1.id;
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
      // Ties are shared, and can span races and drivers, so every observation matching the best margin is
      // kept.
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
        const points = s.overall_total;
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
