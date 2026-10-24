/**
 * Site-wide incident history for History → Incidents (All, by Driver, by Offense). Incidents are `penalties`
 * rows joined with round, driver and offense context. Four queries in total, without the standings engine,
 * which this page doesn't need.
 */

import { type SupabaseEnv, restGetAll, writeHeaders } from './db/client';
import { parseDbErrorCode, type IncidentErrorCode } from './incidentErrors';
import {
  getPenaltiesForDriver,
  getPenaltiesForSubsessions,
  getPenaltyOffenses,
  type Penalty,
  type PenaltyOffense,
} from './db/penalties';
import { getStandingsExcludedRoundIds } from './db/rounds';
import { getAllRounds, computeDisplayRoundNumbers } from './results/rounds';
import { driversSelect, type DriverBasic, type RoundSummary } from './results/rows';
import { getPostedSubsessionIds } from './incidentReports';
import {
  effectiveTimePenaltySeconds,
  effectivePointsPenalty,
  effectivePenaltyPoints,
} from './penalties/effective';

export interface IncidentRow {
  id: string;
  subsessionId: number;
  seasonLabel: string | null;
  /** The round's number within its own season. Null means this round is excluded from standings (exhibition/test round, or a whole non-championship season) — same "Exhibition" display convention as everywhere else on the site that shows a round number (see computeDisplayRoundNumbers). */
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
  /** Every race (subsession + race_number pair) this driver has ever started on file, across every round — the denominator for the By Driver table's Inc/Race and Pen/Race columns. Pulled straight from race_score_results_public rather than the full standings engine (see this file's header comment on why), so it's every start regardless of season/class/exhibition status. */
  racesStarted: number;
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

/** Every incident plus the by-driver and by-offense rollups, computed once for all three views. */
export async function getAllIncidents(env: SupabaseEnv): Promise<IncidentsData> {
  return loadIncidents(env);
}

/**
 * Just the All Incidents rows (same shape, same "posted reports only" rule,
 * same round numbering as getAllIncidents) for a chosen set of rounds — the
 * Event Briefing page's Past Incidents table. Skips the site-wide fetches the
 * By Driver / By Offense views need, so it stays cheap.
 */
export async function getIncidentsForSubsessions(
  env: SupabaseEnv,
  onlySubsessionIds: number[],
  /** Admin tools (the layout map's pin editor) need incidents from rounds that aren't posted yet; public pages never pass this. */
  options: { includeUnposted?: boolean } = {},
): Promise<IncidentRow[]> {
  if (onlySubsessionIds.length === 0) return [];
  return (await loadIncidents(env, onlySubsessionIds, options.includeUnposted === true)).all;
}

async function loadIncidents(
  env: SupabaseEnv,
  onlySubsessionIds?: number[],
  includeUnposted = false,
): Promise<IncidentsData> {
  const rounds = await getAllRounds(env);
  // Round numbers are per season, so they're always worked out from every round; only the penalty fetch narrows down.
  const subsessionIds = onlySubsessionIds ?? rounds.map((r) => r.subsession_id);

  const [allPenalties, postedRoundIds, driversBasic, offenses, excludedRoundIds, raceStartRows] =
    await Promise.all([
      getPenaltiesForSubsessions(env, subsessionIds),
      // Only rounds whose incident report stewards have POSTED (admin >
      // Incident Reporting, 0092_incident_posting.sql) show up on the public
      // Incidents page — everything earlier was backfilled as posted.
      getPostedSubsessionIds(env),
      // includeAi: an incident may name an AI exhibition entrant, who would otherwise show as "—".
      driversSelect(env, { includeAi: true }),
      getPenaltyOffenses(env),
      getStandingsExcludedRoundIds(env),
      // Minimal columns to count each driver's starts for the Inc/Race and Pen/Race columns.
      subsessionIds.length === 0 || onlySubsessionIds
        ? Promise.resolve([] as { subsession_id: number; race_number: number; driver_id: string }[])
        : restGetAll<{ subsession_id: number; race_number: number; driver_id: string }>(
            env,
            `race_score_results_public?select=subsession_id,race_number,driver_id&subsession_id=in.(${subsessionIds.join(',')})`,
          ),
    ]);

  const penalties = includeUnposted
    ? allPenalties
    : allPenalties.filter((p) => postedRoundIds.has(p.subsession_id));

  const racesStartedByDriver = new Map<string, Set<string>>();
  for (const row of raceStartRows) {
    if (!racesStartedByDriver.has(row.driver_id)) racesStartedByDriver.set(row.driver_id, new Set());
    racesStartedByDriver.get(row.driver_id)!.add(`${row.subsession_id}:${row.race_number}`);
  }

  const all = buildIncidentRows(penalties, rounds, driversBasic, offenses, excludedRoundIds);
  const offenseById = new Map(offenses.map((o) => [o.id, o]));
  return {
    all,
    byDriver: rollUpByDriver(all, racesStartedByDriver),
    byOffense: rollUpByOffense(all, offenseById),
  };
}

/**
 * The incidents one driver is penalised in or involved in, posted rounds only, newest first: the driver
 * profile's list (FR1.3). The same rows getAllIncidents' by-driver rollup gives, but only this driver's
 * penalties are read, filtered in the database.
 */
export async function getIncidentsForDriver(env: SupabaseEnv, driverId: string): Promise<IncidentRow[]> {
  const [penalties, rounds, postedRoundIds, driversBasic, offenses, excludedRoundIds] = await Promise.all([
    getPenaltiesForDriver(env, driverId),
    getAllRounds(env),
    getPostedSubsessionIds(env),
    driversSelect(env, { includeAi: true }),
    getPenaltyOffenses(env),
    getStandingsExcludedRoundIds(env),
  ]);
  const posted = penalties.filter((p) => postedRoundIds.has(p.subsession_id));
  return buildIncidentRows(posted, rounds, driversBasic, offenses, excludedRoundIds).filter(
    (row) => row.driver?.id === driverId || row.involvedDrivers.some((d) => d.id === driverId),
  );
}

/** Incident rows for these penalties, newest round first (oldest penalty first within a round). */
function buildIncidentRows(
  penalties: Penalty[],
  rounds: RoundSummary[],
  driversBasic: DriverBasic[],
  offenses: PenaltyOffense[],
  excludedRoundIds: Set<number>,
): IncidentRow[] {
  const roundBySubsession = new Map(rounds.map((r) => [r.subsession_id, r]));
  const driverById = new Map(driversBasic.map((d) => [d.id, d]));
  const offenseById = new Map(offenses.map((o) => [o.id, o]));
  // Round numbers count within each season (computeDisplayRoundNumbers numbers
  // whatever list it's handed in one run, so it has to be called once per
  // season — passing every round at once gave an all-time count).
  const roundsBySeason = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const key = r.season_id ?? r.season_label ?? '';
    if (!roundsBySeason.has(key)) roundsBySeason.set(key, []);
    roundsBySeason.get(key)!.push(r);
  }
  const displayRoundNumbers = new Map<number, number | null>();
  for (const seasonRounds of roundsBySeason.values()) {
    for (const [id, n] of computeDisplayRoundNumbers(seasonRounds, excludedRoundIds, new Set()))
      displayRoundNumbers.set(id, n);
  }

  const all: IncidentRow[] = [];
  for (const p of penalties) {
    // A penalty whose round is gone from the externally-populated curated_rounds is skipped.
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
      involvedDrivers: p.involved_driver_ids
        .map((id) => driverById.get(id))
        .filter((d): d is DriverBasic => !!d),
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
  return all;
}

function rollUpByDriver(
  all: IncidentRow[],
  racesStartedByDriver: Map<string, Set<string>>,
): DriverIncidentAggregate[] {
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
          racesStarted: racesStartedByDriver.get(driverId)?.size ?? 0,
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
  return [...byDriverMap.values()].sort((a, b) => b.incidentsInvolvedIn - a.incidentsInvolvedIn);
}

function rollUpByOffense(
  all: IncidentRow[],
  offenseById: Map<string, PenaltyOffense>,
): OffenseIncidentAggregate[] {
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
  return [...byOffenseMap.values()].sort((a, b) => b.incidentCount - a.incidentCount);
}

// --- Incident Management on the own profile (U5; BR11.1-BR11.14) ---------------------------------
// The database decides what is listed and who may comment or appeal (my_incidents, add_my_incident_comment,
// can_appeal_penalty in 20261101120000_incident_management.sql); this maps its rows to what the tab shows.

/** my_incidents() returns at most this many rows (NFR3.4). */
export const MY_INCIDENTS_LIMIT = 200;
export const INCIDENT_COMMENT_MAX_LENGTH = 2000;

/** One row of my_incidents(), as PostgREST returns it. */
export interface MyIncidentDbRow {
  kind: 'pending_report' | 'posted_penalty';
  id: string;
  subsession_id: number;
  round_label: string | null;
  occurred_at: string | null;
  session: string | null;
  lap: number | null;
  turn: string | null;
  description: string | null;
  penalized_car: string | null;
  involved_cars: string[] | null;
  i_am_penalized: boolean;
  my_comment_exists: boolean;
  appeal_window_closes_at: string | null;
  my_appeal_status: 'none' | 'open' | 'reviewed' | 'dismissed';
  points_before: number | null;
  points_after: number | null;
  time_or_points_changed: boolean;
}

export type IncidentManagementState = 'pending' | 'posted' | 'appealed' | 'reviewed';

export interface IncidentManagementRow {
  kind: 'pending' | 'posted';
  /** The incident report id (pending) or the penalty id (posted). */
  id: string;
  subsessionId: number;
  roundLabel: string;
  occurredAt: string | null;
  state: IncidentManagementState;
  /** "Pending" on pending rows; "#12" on posted rows; "" for a racing incident. */
  penalizedLabel: string;
  /** "#04, #12", or "—" when no other car is listed. */
  involvedLabel: string;
  sessionLabel: string;
  lap: number | null;
  turn: string | null;
  /** Pending rows only: the report's own description, for the Add Comment popup (BR11.18). */
  description: string | null;
  commentSent: boolean;
  /** Which buttons the row shows (BR11.5, BR11.8, BR11.10). */
  canComment: boolean;
  canViewIncident: boolean;
  canAppeal: boolean;
  appealSubmitted: boolean;
  /** Reviewed rows: "-2 PP", "No change", "No change (time or points changed)" or "Reviewed" (BR11.11). */
  resultLabel: string | null;
  /** The text that goes with the row's colour (BR11.12). */
  statusLabel: string;
}

export interface IncidentManagementView {
  rows: IncidentManagementRow[];
  /** True when the list hit the 200-row cap ("Showing your 200 most recent incidents."). */
  capped: boolean;
}

/** "Race 2", "Qualifying" or "Practice" for a report session ("race:2") or a penalty's session type. */
export function incidentSessionLabel(session: string | null): string {
  if (!session) return '—';
  const [type, num] = session.split(':');
  if (type === 'qualifying') return 'Qualifying';
  if (type === 'practice') return 'Practice';
  if (type === 'race') return num ? `Race ${num}` : 'Race';
  return session;
}

/**
 * The penalty-point change an appeal made: effective PP minus the original. my_incidents() returns both
 * values with the formula of effectivePenaltyPoints (src/lib/penalties/effective.ts).
 */
export function penaltyPointsDifference(before: number, after: number): number {
  return after - before;
}

/** What a reviewed row shows in place of the appeal button (BR11.11 amended). */
export function reviewedResultLabel(row: {
  i_am_penalized: boolean;
  points_before: number | null;
  points_after: number | null;
  time_or_points_changed: boolean;
}): string {
  // Only the penalized driver's row carries the number; an involved driver sees that it was reviewed.
  if (!row.i_am_penalized) return 'Reviewed';
  const diff = penaltyPointsDifference(row.points_before ?? 0, row.points_after ?? row.points_before ?? 0);
  if (diff === 0) return row.time_or_points_changed ? 'No change (time or points changed)' : 'No change';
  return `${diff > 0 ? '+' : ''}${diff} PP`;
}

const carList = (cars: string[] | null) =>
  cars && cars.length > 0 ? cars.map((car) => `#${car}`).join(', ') : '—';

/** One row's view model; `now` decides whether Submit Appeal is still offered. */
export function buildIncidentManagementRow(row: MyIncidentDbRow, now: Date): IncidentManagementRow {
  const base = {
    id: row.id,
    subsessionId: row.subsession_id,
    roundLabel: row.round_label ?? `Round ${row.subsession_id}`,
    occurredAt: row.occurred_at,
    involvedLabel: carList(row.involved_cars),
    sessionLabel: incidentSessionLabel(row.session),
    lap: row.lap,
    turn: row.turn,
  };
  if (row.kind === 'pending_report') {
    return {
      ...base,
      kind: 'pending',
      state: 'pending',
      penalizedLabel: 'Pending',
      description: row.description,
      commentSent: row.my_comment_exists,
      canComment: !row.my_comment_exists,
      canViewIncident: false,
      canAppeal: false,
      appealSubmitted: false,
      resultLabel: null,
      statusLabel: row.my_comment_exists ? 'Comment sent' : 'Pending',
    };
  }
  const posted = {
    ...base,
    kind: 'posted' as const,
    penalizedLabel: row.penalized_car ? `#${row.penalized_car}` : '',
    description: null,
    commentSent: false,
    canComment: false,
    canViewIncident: true,
  };
  if (row.my_appeal_status === 'open') {
    return {
      ...posted,
      state: 'appealed',
      canAppeal: false,
      appealSubmitted: true,
      resultLabel: null,
      statusLabel: 'Appeal Submitted',
    };
  }
  if (row.my_appeal_status === 'reviewed' || row.my_appeal_status === 'dismissed') {
    const result = reviewedResultLabel(row);
    return {
      ...posted,
      state: 'reviewed',
      canAppeal: false,
      appealSubmitted: false,
      resultLabel: result,
      statusLabel: result,
    };
  }
  const closesAt = row.appeal_window_closes_at ? new Date(row.appeal_window_closes_at).getTime() : NaN;
  const open = Number.isFinite(closesAt) && now.getTime() < closesAt;
  return {
    ...posted,
    state: 'posted',
    canAppeal: open,
    appealSubmitted: false,
    resultLabel: null,
    statusLabel: open ? 'Appeal open' : 'Appeal window closed',
  };
}

/** The tab's rows, in the order the database returned them (newest first). */
export function buildIncidentManagementView(
  rows: MyIncidentDbRow[],
  now: Date = new Date(),
): IncidentManagementView {
  return {
    rows: rows.map((row) => buildIncidentManagementRow(row, now)),
    capped: rows.length >= MY_INCIDENTS_LIMIT,
  };
}

async function userRpc(env: SupabaseEnv, accessToken: string, fn: string, args: Record<string, unknown>) {
  return fetch(`${env.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: writeHeaders(env, accessToken),
    body: JSON.stringify(args),
  });
}

/** The signed-in owner's Incident Management list. Throws on failure; the page shows its load error. */
export async function getMyIncidents(env: SupabaseEnv, accessToken: string): Promise<IncidentManagementView> {
  const res = await userRpc(env, accessToken, 'my_incidents', {});
  if (!res.ok) throw new Error(`my_incidents failed (${res.status})`);
  return buildIncidentManagementView((await res.json()) as MyIncidentDbRow[]);
}

export interface IncidentPanelData {
  /** Null when either read failed: the tab says so and the rest of the profile renders (NFR4.2). */
  view: IncidentManagementView | null;
  /** The listed penalties' Incident Details rows, for View Incident (BR11.8 amended). */
  detailRows: IncidentRow[];
}

/** The status of a failed read, for a content-free log line; 'network' when there was no response. */
function failureStatus(err: unknown): string {
  const match = /\b([1-5]\d\d)\b/.exec(err instanceof Error ? err.message : String(err));
  return match ? match[1] : 'network';
}

/**
 * The owner's tab data: my_incidents() and the driver's posted incident rows, in parallel (NFR3.1). Never
 * throws; a failure is logged with its status only (NFR9.1).
 */
export async function loadIncidentPanel(
  env: SupabaseEnv,
  accessToken: string,
  driverId: string,
): Promise<IncidentPanelData> {
  try {
    const [view, rows] = await Promise.all([
      getMyIncidents(env, accessToken),
      getIncidentsForDriver(env, driverId),
    ]);
    const listed = new Set(view.rows.filter((r) => r.kind === 'posted').map((r) => r.id));
    return { view, detailRows: rows.filter((row) => listed.has(row.id)) };
  } catch (err) {
    console.error('incident-management load failed', failureStatus(err));
    return { view: null, detailRows: [] };
  }
}

export type IncidentActionCode = IncidentErrorCode | 'UNKNOWN';

/** Adds the owner's one final comment (add_my_incident_comment). Never throws; failures come back as a code. */
export async function addMyIncidentComment(
  env: SupabaseEnv,
  accessToken: string,
  reportId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; code: IncidentActionCode }> {
  try {
    const res = await userRpc(env, accessToken, 'add_my_incident_comment', {
      p_report_id: reportId,
      p_body: body,
    });
    if (res.ok) return { ok: true };
    return { ok: false, code: parseDbErrorCode(await res.text()) ?? 'UNKNOWN' };
  } catch {
    return { ok: false, code: 'UNKNOWN' };
  }
}

export type CanAppealResult = 'ok' | 'NOT_INVOLVED' | 'ALREADY_APPEALED' | 'CLOSED' | 'UNKNOWN';

/** can_appeal_penalty: run before any upload, so a refused appeal leaves no files. Throws on failure. */
export async function canAppealPenalty(
  env: SupabaseEnv,
  accessToken: string,
  penaltyId: string,
): Promise<CanAppealResult> {
  const res = await userRpc(env, accessToken, 'can_appeal_penalty', { p_penalty_id: penaltyId });
  if (!res.ok) throw new Error(`can_appeal_penalty failed (${res.status})`);
  const value = (await res.json()) as unknown;
  return value === 'ok' || value === 'NOT_INVOLVED' || value === 'ALREADY_APPEALED' || value === 'CLOSED'
    ? value
    : 'UNKNOWN';
}
