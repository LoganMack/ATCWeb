/**
 * Site-wide incident history — every steward-logged incident (rulebook
 * 18.3, section 5 "Stewarding") ever recorded, across every round on file,
 * flattened for the History → Incidents page's three views (All Incidents,
 * by Driver, by Offense). There is no separate "incidents" table — every
 * row here is a `penalties` row (see src/lib/supabase.ts's own doc comment
 * on that table); this file just joins it with the round/driver/offense
 * context needed to display it outside the one-round-at-a-time Incident
 * Report page (src/pages/results/[subsessionId]/incidents.astro).
 *
 * Deliberately NOT built on computeDriverCareerStats() (src/lib/results.ts)
 * — that function runs the full standings/points engine for every driver's
 * whole career, which this page doesn't need at all. This is just raw
 * incident facts (who, what, how many, how much), so the fetch here is
 * much lighter: one getAllRounds(), one bulk getPenaltiesForSubsessions()
 * across every round on file, one driversSelect(), one getPenaltyOffenses()
 * — four queries total, no per-round or per-driver looping against the
 * database.
 */

import { type SupabaseEnv, getPenaltiesForSubsessions, getPenaltyOffenses, getStandingsExcludedRoundIds } from './supabase';
import { getAllRounds, driversSelect, computeDisplayRoundNumbers, type DriverBasic } from './results';
import { effectiveTimePenaltySeconds, effectivePointsPenalty, effectivePenaltyPoints } from './penalties';

export interface IncidentRow {
  id: string;
  subsessionId: number;
  seasonLabel: string | null;
  /** Null means this round is excluded from standings (exhibition/test round, or a whole non-championship season) — same "Exhibition" display convention as everywhere else on the site that shows a round number (see computeDisplayRoundNumbers). */
  displayRoundNumber: number | null;
  trackName: string;
  startTime: string;
  sessionType: 'race' | 'qualifying' | 'practice';
  raceNumber: number;
  incidentNumber: string | null;
  lap: number | null;
  /** Null means "Racing Incident" — reviewed and judged nobody's fault, no driver at fault (see Penalty.driver_id's own doc comment). Shown as "RI" in the table. */
  driver: DriverBasic | null;
  involvedDrivers: DriverBasic[];
  offenseIds: string[];
  offenseNames: string[];
  /** Effective (appeal-aware) PP awarded by this incident. */
  penaltyPoints: number;
  /** Effective (appeal-aware) time penalty, in seconds — null when no time penalty was applied. */
  timePenaltySeconds: number | null;
  /** Effective (appeal-aware) flat championship-points deduction. A positive number IS the amount lost — never net against anything else. */
  pointsPenalty: number;
  isWarning: boolean;
  isAppealed: boolean;
  description: string | null;
  createdAt: string;
}

export interface DriverIncidentAggregate {
  driver: DriverBasic;
  /** Every incident this driver appears in at all — either as the penalized driver (driver_id) OR tagged as involved (involved_driver_ids). */
  incidentsInvolvedIn: number;
  /** Just the incidents where this driver was the one actually penalized (driver_id match) — a subset of incidentsInvolvedIn. */
  timesPenalized: number;
  /** Sum of effective penalty points awarded across every incident this driver was penalized for. */
  penaltyPoints: number;
  /** Sum of effective points_penalty across every incident this driver was penalized for — points LOST, not a net swing (see IncidentRow.pointsPenalty). */
  pointsLost: number;
  /** Every incident this driver appears in at all (involved-in superset, not just timesPenalized), newest first — what the expanded row lists. */
  incidents: IncidentRow[];
}

export interface OffenseIncidentAggregate {
  offenseId: string;
  offenseName: string;
  /** Every incident tagged with this offense. An incident tagged with more than one offense counts toward each one's total — there's no way to split one incident's PP/points across multiple tagged offenses, so each tagged offense gets full credit for the whole incident, same as a driver tagged as both penalized-party and involved-elsewhere would. */
  incidentCount: number;
  penaltyPoints: number;
  pointsLost: number;
  incidents: IncidentRow[];
}

export interface IncidentsData {
  all: IncidentRow[];
  byDriver: DriverIncidentAggregate[];
  byOffense: OffenseIncidentAggregate[];
}

/**
 * Every incident ever logged, plus the by-driver and by-offense rollups —
 * everything the Incidents history tab needs, computed once and reused
 * across all three of its views (the same "share one expensive fetch"
 * shape as getSeasonOverallContext elsewhere in this codebase).
 */
export async function getAllIncidents(env: SupabaseEnv): Promise<IncidentsData> {
  const rounds = await getAllRounds(env);
  const subsessionIds = rounds.map((r) => r.subsession_id);

  const [penalties, driversBasic, offenses, excludedRoundIds] = await Promise.all([
    getPenaltiesForSubsessions(env, subsessionIds),
    // includeAi: true — a penalty could in principle tag an AI-flagged
    // entrant (an exhibition-only synthetic driver, see DriverBasic's own
    // doc comment); excluding them here would leave that incident's driver
    // unresolved (rendered as "—") instead of showing the actual name.
    driversSelect(env, { includeAi: true }),
    getPenaltyOffenses(env),
    getStandingsExcludedRoundIds(env),
  ]);

  const roundBySubsession = new Map(rounds.map((r) => [r.subsession_id, r]));
  const driverById = new Map(driversBasic.map((d) => [d.id, d]));
  const offenseById = new Map(offenses.map((o) => [o.id, o]));
  const displayRoundNumbers = computeDisplayRoundNumbers(rounds, excludedRoundIds, new Set());

  const all: IncidentRow[] = [];
  for (const p of penalties) {
    // A penalty whose round has since been removed from curated_rounds
    // (shouldn't normally happen — see this file's own header on that
    // table being externally populated) is skipped rather than shown with
    // no track/season context.
    const round = roundBySubsession.get(p.subsession_id);
    if (!round) continue;

    all.push({
      id: p.id,
      subsessionId: p.subsession_id,
      seasonLabel: round.season_label,
      displayRoundNumber: displayRoundNumbers.get(p.subsession_id) ?? null,
      trackName: round.track_name,
      startTime: round.start_time,
      sessionType: p.session_type,
      raceNumber: p.race_number,
      incidentNumber: p.incident_number,
      lap: p.lap,
      driver: p.driver_id ? (driverById.get(p.driver_id) ?? null) : null,
      involvedDrivers: p.involved_driver_ids.map((id) => driverById.get(id)).filter((d): d is DriverBasic => !!d),
      offenseIds: p.offense_ids,
      offenseNames: p.offense_ids.map((id) => offenseById.get(id)?.name ?? '?'),
      penaltyPoints: effectivePenaltyPoints(p),
      timePenaltySeconds: effectiveTimePenaltySeconds(p),
      pointsPenalty: effectivePointsPenalty(p),
      isWarning: p.is_warning,
      isAppealed: p.is_appealed,
      description: p.description,
      createdAt: p.created_at,
    });
  }

  all.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  // --- By driver --------------------------------------------------------
  const byDriverMap = new Map<string, DriverIncidentAggregate>();
  for (const row of all) {
    const involved = new Map<string, DriverBasic>();
    if (row.driver) involved.set(row.driver.id, row.driver);
    for (const d of row.involvedDrivers) involved.set(d.id, d);

    for (const [driverId, driver] of involved) {
      if (!byDriverMap.has(driverId)) {
        byDriverMap.set(driverId, {
          driver,
          incidentsInvolvedIn: 0,
          timesPenalized: 0,
          penaltyPoints: 0,
          pointsLost: 0,
          incidents: [],
        });
      }
      const agg = byDriverMap.get(driverId)!;
      agg.incidentsInvolvedIn += 1;
      agg.incidents.push(row);
      if (row.driver?.id === driverId) {
        agg.timesPenalized += 1;
        agg.penaltyPoints += row.penaltyPoints;
        agg.pointsLost += row.pointsPenalty;
      }
    }
  }
  const byDriver = [...byDriverMap.values()].sort((a, b) => b.incidentsInvolvedIn - a.incidentsInvolvedIn);

  // --- By offense ---------------------------------------------------------
  const byOffenseMap = new Map<string, OffenseIncidentAggregate>();
  for (const row of all) {
    for (const offenseId of row.offenseIds) {
      if (!byOffenseMap.has(offenseId)) {
        byOffenseMap.set(offenseId, {
          offenseId,
          offenseName: offenseById.get(offenseId)?.name ?? '?',
          incidentCount: 0,
          penaltyPoints: 0,
          pointsLost: 0,
          incidents: [],
        });
      }
      const agg = byOffenseMap.get(offenseId)!;
      agg.incidentCount += 1;
      agg.penaltyPoints += row.penaltyPoints;
      agg.pointsLost += row.pointsPenalty;
      agg.incidents.push(row);
    }
  }
  const byOffense = [...byOffenseMap.values()].sort((a, b) => b.incidentCount - a.incidentCount);

  return { all, byDriver, byOffense };
}
