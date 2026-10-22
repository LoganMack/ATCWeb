// Data gathering for the scoring comparison (unit scoring-ownership, W5; BR6.2).
//
// For one round it reads what the site shows today, what the new view shows, and the
// score_round_preview results, and hands them to scoringAttribution.ts. It reuses the page code
// itself for Today, so the comparison is against what visitors actually see:
//   * results page (src/pages/results/[subsessionId]/fragment.astro): getRoundResults on
//     race_scores_public, then applyPenaltiesToRoundResults with the round's posted penalties and
//     the season's ruleset. Gives position, finish points, class points, each bonus and the
//     deduction (Overall view), and class position and the Per Class view's finish points.
//   * overall standings (computeOverallSeasonStandings): buildSeasonOverallContext's adjustment, or
//     finish + finesse + pole + deduction for an untouched row. Gives overall_total.
//   * class standings (computeSeasonStandings): computeSeasonClassAdjustments' total, or the stored
//     total_points for an untouched row. Gives class_total.
// Every page reads scores with the anon key, admins included, so Today is the same for both
// audiences: an unposted round's penalties are hidden (RLS on penalties, race_scores_public hides
// the deduction) and the results page skips the engine. The service-role key used here bypasses
// RLS, so this module drops an unposted round's penalties itself.
//
// New follows race_score_results_public: the final set for admins and posted rounds, otherwise the
// raw set with no deduction. It is derived from the base table, so it does not depend on how
// is_admin() treats the service role.

import { restGet, restGetAll, type SupabaseEnv } from '../../src/lib/db/client';
import { getRoundResults, type RaceResultRow } from '../../src/lib/results/roundResults';
import { applyPenaltiesToRoundResults } from '../../src/lib/penalties/roundResults';
import { computeSeasonClassAdjustments, type SeasonClassScoreRow } from '../../src/lib/penalties/seasonAdjustments';
import { buildSeasonOverallContext } from '../../src/lib/results/seasonContext';
import {
  driversSelect,
  getCuratedRaceResultsForSubsessions,
  getLapStatsForSubsessions,
  getRaceScoresForSubsessionsOverall,
  resultKey,
  type DriverBasic,
  type RaceScoreRow,
} from '../../src/lib/results/rows';
import { getRoundBySubsessionId } from '../../src/lib/results/rounds';
import { getPenaltiesForSubsession } from '../../src/lib/db/penalties';
import { getDriverClasses, type Lookup } from '../../src/lib/db/lookups';
import { getSeasonById, getScoringRulesets, resolveSeasonRuleset, type ScoringRuleset, type Season } from '../../src/lib/db/seasons';
import {
  AUDIENCES,
  SWITCHES,
  attributeRow,
  pairSwitches,
  pairsNeeded,
  switchesWithOnly,
  type Audience,
  type AudienceInput,
  type DiffLine,
  type FieldValues,
  type RowInput,
  type SwitchName,
} from './scoringAttribution';

/** One race_score_results row, as the table and score_round_preview return it. */
export interface ScoreResultRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  dsq: boolean;
  raw_position: number | null;
  raw_class_position: number | null;
  raw_finish_points: number;
  raw_class_points: number;
  raw_finesse_bonus: number;
  raw_pole_bonus: number;
  raw_aggression_bonus: number;
  raw_lap_led_bonus: number;
  raw_fewest_incidents_bonus: number;
  raw_fastest_lap_bonus: number;
  raw_sprint_sweep_bonus: number;
  raw_overall_total: number;
  raw_class_total: number;
  final_position: number | null;
  final_class_position: number | null;
  final_finish_points: number;
  final_class_points: number;
  final_finesse_bonus: number;
  final_pole_bonus: number;
  final_aggression_bonus: number;
  final_lap_led_bonus: number;
  final_fewest_incidents_bonus: number;
  final_fastest_lap_bonus: number;
  final_sprint_sweep_bonus: number;
  final_points_deduction: number;
  final_overall_total: number;
  final_class_total: number;
}

/** The legacy race_scores columns the stale-stored-score check compares (the base table, not the view). */
export interface StoredScoreRow {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  finish_points: number;
  class_points: number;
  finesse_bonus: number;
  pole_bonus: number;
  aggression_bonus: number;
  lap_led_bonus: number;
  fewest_incidents_bonus: number;
  fastest_lap_bonus: number;
  sprint_sweep_bonus: number;
  scored_position: number | null;
  dsq: boolean;
}

type ScoreSet = 'raw' | 'final';

const STORED_SELECT =
  'subsession_id,race_number,driver_id,finish_points,class_points,finesse_bonus,pole_bonus,aggression_bonus,' +
  'lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,scored_position,dsq';

// The columns computeSeasonStandings reads (getRaceScoresForSeasonClass), plus class_id to group by.
const CLASS_SCORES_SELECT =
  'subsession_id,race_number,driver_id,class_id,team_id,total_points,class_points,finesse_bonus,points_deduction,' +
  'pole_bonus,aggression_bonus,lap_led_bonus,fewest_incidents_bonus,fastest_lap_bonus,sprint_sweep_bonus,classified,dsq';

const rowKey = (raceNumber: number, driverId: string) => `${raceNumber}:${driverId}`;

/** Lookups every round shares, read once per run. */
export interface SharedData {
  drivers: DriverBasic[];
  classes: Lookup[];
  rulesets: ScoringRuleset[];
  seasons: Map<string, Season | null>;
}

export async function loadSharedData(env: SupabaseEnv): Promise<SharedData> {
  const [drivers, classes, rulesets] = await Promise.all([
    driversSelect(env),
    getDriverClasses(env),
    getScoringRulesets(env),
  ]);
  return { drivers, classes, rulesets, seasons: new Map() };
}

async function seasonFor(env: SupabaseEnv, shared: SharedData, seasonId: string): Promise<Season | null> {
  if (!shared.seasons.has(seasonId)) shared.seasons.set(seasonId, await getSeasonById(env, seasonId));
  return shared.seasons.get(seasonId) ?? null;
}

/** Whether the round's incident report is posted. Unlike isRoundPosted, a failed read throws: guessing would mislabel every line. */
async function readPosted(env: SupabaseEnv, subsessionId: number): Promise<boolean> {
  const rows = await restGet<{ posted: boolean }[]>(
    env,
    `round_incident_status?select=posted&subsession_id=eq.${subsessionId}`,
  );
  return rows[0]?.posted === true;
}

function sumBonuses(r: RaceResultRow): number {
  return (
    r.finesseBonus +
    r.poleBonus +
    r.aggressionBonus +
    r.lapLedBonus +
    r.fewestIncidentsBonus +
    r.fastestLapBonus +
    r.sprintSweepBonus
  );
}

/** The finish points a results-page row shows: its total less every other component. */
function finishPointsOf(r: RaceResultRow): number {
  return r.totalPoints - r.classPoints - sumBonuses(r) - r.pointsDeduction;
}

export interface TodayRound {
  posted: boolean;
  /** race:driver -> fields as the site shows them today (both audiences). */
  values: Map<string, FieldValues>;
  names: Map<string, string>;
}

/** What the site shows today for one round, from the page code itself (see the file header). */
export async function computeToday(env: SupabaseEnv, shared: SharedData, subsessionId: number): Promise<TodayRound> {
  const [round, roundResults, penaltiesAll, posted, overallScores, classScores, rawResults, lapStats] =
    await Promise.all([
      getRoundBySubsessionId(env, subsessionId),
      getRoundResults(env, subsessionId),
      getPenaltiesForSubsession(env, subsessionId),
      readPosted(env, subsessionId),
      getRaceScoresForSubsessionsOverall(env, [subsessionId]),
      restGet<(RaceScoreRow & { class_id: number })[]>(
        env,
        `race_scores_public?select=${CLASS_SCORES_SELECT}&subsession_id=eq.${subsessionId}`,
      ),
      getCuratedRaceResultsForSubsessions(env, [subsessionId]),
      getLapStatsForSubsessions(env, [subsessionId]),
    ]);
  if (!round) throw new Error(`Round ${subsessionId} not found in curated_rounds`);
  const season = round.season_id ? await seasonFor(env, shared, round.season_id) : null;
  const rules = season ? (resolveSeasonRuleset(season, shared.rulesets)?.rules ?? null) : null;
  // What an anon reader gets: an unposted round's penalties are hidden by RLS.
  const penalties = posted ? penaltiesAll : [];

  // Results page. Its unposted stripDeduction step is a no-op on these fields, because
  // race_scores_public already reports an unposted round's deduction as 0.
  const eligible = new Map(shared.classes.map((c) => [c.id, c.name !== 'Alpha']));
  const results =
    penalties.length > 0
      ? applyPenaltiesToRoundResults(roundResults, penalties, round.format, eligible, rules, subsessionId)
      : roundResults;

  const values = new Map<string, FieldValues>();
  const names = new Map<string, string>();
  const entry = (raceNumber: number, driverId: string): FieldValues => {
    const key = rowKey(raceNumber, driverId);
    if (!values.has(key)) values.set(key, { row: 1 });
    return values.get(key)!;
  };
  for (const [raceNumber, rows] of results.overall) {
    for (const r of rows) {
      if (r.notInRoster) continue;
      names.set(r.driver.id, r.driver.name);
      Object.assign(entry(raceNumber, r.driver.id), {
        position: r.position,
        finish_points: finishPointsOf(r),
        class_points: r.classPoints,
        finesse_bonus: r.finesseBonus,
        pole_bonus: r.poleBonus,
        aggression_bonus: r.aggressionBonus,
        lap_led_bonus: r.lapLedBonus,
        fewest_incidents_bonus: r.fewestIncidentsBonus,
        fastest_lap_bonus: r.fastestLapBonus,
        sprint_sweep_bonus: r.sprintSweepBonus,
        // The engine carries the deduction as a signed addend; the new tables store it positive.
        deduction: -r.pointsDeduction,
      });
    }
  }
  for (const byRace of results.byClass.values()) {
    for (const [raceNumber, rows] of byRace) {
      for (const r of rows) {
        Object.assign(entry(raceNumber, r.driver.id), {
          class_position: r.position,
          class_view_finish_points: finishPointsOf(r),
        });
      }
    }
  }

  // Overall standings.
  const ctx = buildSeasonOverallContext(
    new Set(),
    shared.drivers,
    overallScores,
    rawResults,
    penalties,
    [round],
    lapStats,
    rules,
  );
  for (const s of ctx.overallScores) {
    const adjustment = ctx.adjustments.get(`${s.subsession_id}:${s.race_number}:${s.driver_id}`);
    entry(s.race_number, s.driver_id).overall_total = adjustment
      ? adjustment.overallTotalPoints
      : s.finish_points + s.finesse_bonus + s.pole_bonus + s.points_deduction;
  }

  // Class standings: rows shaped exactly as computeSeasonStandings shapes them, one class at a time.
  const classNameById = new Map(shared.classes.map((c) => [c.id, c.name]));
  const byClass = new Map<number, (RaceScoreRow & { class_id: number })[]>();
  for (const s of classScores) {
    if (!byClass.has(s.class_id)) byClass.set(s.class_id, []);
    byClass.get(s.class_id)!.push(s);
  }
  for (const [classId, scores] of byClass) {
    const classRows = classScoreRows(scores, ctx);
    const adjustments = computeSeasonClassAdjustments(
      classRows,
      ctx.penalties,
      ctx.formatBySubsession,
      ctx.adjustments,
      ctx.leaderStatsByRace,
      classNameById.get(classId) !== 'Alpha',
      ctx.rulesBySubsession,
    );
    for (const s of scores) {
      const adjustment = adjustments.get(`${s.subsession_id}:${s.race_number}:${s.driver_id}`);
      entry(s.race_number, s.driver_id).class_total = adjustment ? adjustment.totalPoints : s.total_points;
    }
  }

  return { posted, values, names };
}

/** computeSeasonStandings' class rows for one class: non-DSQ rows ranked by raw finishing slot per race. */
function classScoreRows(
  scores: RaceScoreRow[],
  ctx: ReturnType<typeof buildSeasonOverallContext>,
): SeasonClassScoreRow[] {
  const groups = new Map<string, RaceScoreRow[]>();
  for (const s of scores) {
    const key = `${s.subsession_id}:${s.race_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const out: SeasonClassScoreRow[] = [];
  for (const group of groups.values()) {
    const ranked = group
      .filter((s) => !s.dsq)
      .map((s) => {
        const custId = ctx.custIdByDriverId.get(s.driver_id);
        const key = custId != null ? resultKey(s.subsession_id, s.race_number, custId) : null;
        const raw = key ? ctx.rawByKey.get(key) : undefined;
        const lap = key ? ctx.lapStatsByKey.get(key) : undefined;
        return {
          s,
          position: raw?.adjusted_position ?? raw?.finish_position ?? null,
          interval: raw?.interval_ten_thousandths ?? null,
          laps: raw?.laps_complete ?? null,
          avg: lap?.average_lap_ten_thousandths ?? null,
        };
      })
      .filter((r) => r.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number));
    ranked.forEach((r, i) => {
      out.push({
        subsessionId: r.s.subsession_id,
        raceNumber: r.s.race_number,
        driverId: r.s.driver_id,
        dsq: r.s.dsq,
        classified: r.s.classified,
        classPosition: i + 1,
        intervalTenThousandths: r.interval,
        totalPoints: r.s.total_points,
        classPoints: r.s.class_points,
        finesseBonus: r.s.finesse_bonus,
        poleBonus: r.s.pole_bonus,
        aggressionBonus: r.s.aggression_bonus,
        lapLedBonus: r.s.lap_led_bonus,
        fewestIncidentsBonus: r.s.fewest_incidents_bonus,
        fastestLapBonus: r.s.fastest_lap_bonus,
        sprintSweepBonus: r.s.sprint_sweep_bonus,
        pointsDeduction: r.s.points_deduction,
        lapsComplete: r.laps,
        averageLapTenThousandths: r.avg,
      });
    });
  }
  return out;
}

/** The fields one set of a race_score_results (or preview) row shows. */
export function fieldsFromScoreRow(r: ScoreResultRow, set: ScoreSet): FieldValues {
  const p = set === 'raw' ? 'raw_' : 'final_';
  const n = (col: string) => (r as unknown as Record<string, number | null>)[p + col] ?? null;
  return {
    row: 1,
    position: n('position'),
    class_position: n('class_position'),
    finish_points: n('finish_points'),
    class_view_finish_points: n('finish_points'),
    class_points: n('class_points'),
    finesse_bonus: n('finesse_bonus'),
    pole_bonus: n('pole_bonus'),
    aggression_bonus: n('aggression_bonus'),
    lap_led_bonus: n('lap_led_bonus'),
    fewest_incidents_bonus: n('fewest_incidents_bonus'),
    fastest_lap_bonus: n('fastest_lap_bonus'),
    sprint_sweep_bonus: n('sprint_sweep_bonus'),
    deduction: set === 'final' ? r.final_points_deduction : 0,
    overall_total: n('overall_total'),
    class_total: n('class_total'),
  };
}

/** The set race_score_results_public shows this audience (BR4.1, BR4.2). */
export function setFor(audience: Audience, posted: boolean): ScoreSet {
  return audience === 'admin' || posted ? 'final' : 'raw';
}

/** The stale-stored-score fields of a stored race_scores row, shaped like Legacy-mode's raw set. */
export function fieldsFromStored(r: StoredScoreRow): FieldValues {
  return {
    row: 1,
    position: r.dsq ? null : r.scored_position,
    finish_points: r.finish_points,
    class_view_finish_points: r.finish_points,
    class_points: r.class_points,
    finesse_bonus: r.finesse_bonus,
    pole_bonus: r.pole_bonus,
    aggression_bonus: r.aggression_bonus,
    lap_led_bonus: r.lap_led_bonus,
    fewest_incidents_bonus: r.fewest_incidents_bonus,
    fastest_lap_bonus: r.fastest_lap_bonus,
    sprint_sweep_bonus: r.sprint_sweep_bonus,
    // Legacy-mode's overall formula (overall-formula off) and its all-in class total.
    overall_total: r.finish_points + r.finesse_bonus + r.pole_bonus,
    class_total:
      r.finish_points +
      r.class_points +
      r.finesse_bonus +
      r.pole_bonus +
      r.aggression_bonus +
      r.lap_led_bonus +
      r.fewest_incidents_bonus +
      r.fastest_lap_bonus +
      r.sprint_sweep_bonus,
  };
}

const LEGACY_STALE_FIELDS = [
  'row',
  'position',
  'finish_points',
  'class_view_finish_points',
  'class_points',
  'finesse_bonus',
  'pole_bonus',
  'aggression_bonus',
  'lap_led_bonus',
  'fewest_incidents_bonus',
  'fastest_lap_bonus',
  'sprint_sweep_bonus',
  'overall_total',
  'class_total',
] as const;

function pick(values: FieldValues, fields: readonly (keyof FieldValues)[]): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) if (f in values) out[f] = values[f];
  return out;
}

/** Previews in flight at once for one round. The database is small; more parallel calls only queue. */
export const PREVIEW_CONCURRENCY = 2;

/** Retries of a preview that hit the API role's 8 s statement timeout (SQLSTATE 57014). */
export const PREVIEW_RETRIES = 3;

/** Whether a failed response is the statement timeout: a stall of the database, not a bad request. */
export function isStatementTimeout(status: number, body: string): boolean {
  return status >= 500 && body.includes('"57014"');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls score_round_preview with the given switches. A preview takes about 20-30 ms on an idle
 * database, so a statement timeout means the database stalled under load; it is retried after
 * 2, 4 and 8 s before the round is reported as failed.
 */
export async function fetchPreview(
  env: SupabaseEnv,
  subsessionId: number,
  switches: Record<SwitchName, boolean>,
  retries = PREVIEW_RETRIES,
  waitMs: (attempt: number) => number = (attempt) => 2000 * 2 ** attempt,
): Promise<ScoreResultRow[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${env.url}/rest/v1/rpc/score_round_preview`, {
      method: 'POST',
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${env.accessToken ?? env.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_subsession_id: subsessionId, p_switches: switches }),
    });
    if (res.ok) return (await res.json()) as ScoreResultRow[];
    const body = await res.text();
    if (attempt < retries && isStatementTimeout(res.status, body)) {
      await sleep(waitMs(attempt));
      continue;
    }
    throw new Error(`score_round_preview(${subsessionId}) failed with ${res.status}: ${body}`);
  }
}

function byRowKey(rows: ScoreResultRow[]): Map<string, ScoreResultRow> {
  return new Map(rows.map((r) => [rowKey(r.race_number, r.driver_id), r]));
}

/** Runs tasks with at most `limit` in flight, keeping input order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RoundComparison {
  subsessionId: number;
  posted: boolean;
  lines: DiffLine[];
  previewCalls: number;
}

/** Compares one round: Today, New, then (only when something differs) the previews and their attribution. */
export async function compareRound(
  env: SupabaseEnv,
  shared: SharedData,
  subsessionId: number,
): Promise<RoundComparison> {
  const [today, newRows, storedRows] = await Promise.all([
    computeToday(env, shared, subsessionId),
    restGet<ScoreResultRow[]>(env, `race_score_results?select=*&subsession_id=eq.${subsessionId}`),
    restGet<StoredScoreRow[]>(env, `race_scores?select=${STORED_SELECT}&subsession_id=eq.${subsessionId}`),
  ]);
  const newByKey = byRowKey(newRows);
  const storedByKey = new Map(storedRows.map((r) => [rowKey(r.race_number, r.driver_id), r]));
  const keys = [...new Set([...today.values.keys(), ...newByKey.keys()])];

  const newFor = (key: string, audience: Audience): FieldValues => {
    const r = newByKey.get(key);
    return r ? fieldsFromScoreRow(r, setFor(audience, today.posted)) : { row: 0 };
  };
  const todayFor = (key: string): FieldValues => today.values.get(key) ?? { row: 0 };

  // Cheap first pass: no previews for a round where nothing differs.
  const anyDifference = keys.some((key) =>
    AUDIENCES.some((audience) => {
      const t = todayFor(key);
      const n = newFor(key, audience);
      return Object.keys({ ...t, ...n }).some(
        (f) => (t[f as keyof FieldValues] ?? null) !== (n[f as keyof FieldValues] ?? null),
      );
    }),
  );
  if (!anyDifference) return { subsessionId, posted: today.posted, lines: [], previewCalls: 0 };

  const configs: { name: 'legacy' | SwitchName; on: SwitchName[] }[] = [
    { name: 'legacy', on: [] },
    ...SWITCHES.map((s) => ({ name: s, on: [s] })),
  ];
  const previews = await mapLimit(configs, PREVIEW_CONCURRENCY, (c) => fetchPreview(env, subsessionId, switchesWithOnly(c.on)));
  const legacyByKey = byRowKey(previews[0]);
  const singleByKey = new Map<SwitchName, Map<string, ScoreResultRow>>(
    SWITCHES.map((s, i) => [s, byRowKey(previews[i + 1])]),
  );

  const previewFields = (
    rows: Map<string, ScoreResultRow>,
    key: string,
    audience: Audience,
    oneSided: boolean,
  ): FieldValues => {
    const r = rows.get(key);
    if (!r) return { row: 0 };
    const fields = fieldsFromScoreRow(r, setFor(audience, today.posted));
    return oneSided ? { row: 1 } : fields;
  };

  const inputs: RowInput[] = keys.map((key) => {
    const [raceText, driverId] = key.split(/:(.*)/s);
    const oneSided = !today.values.has(key) || !newByKey.has(key);
    const audiences: Partial<Record<Audience, AudienceInput>> = {};
    for (const audience of AUDIENCES) {
      const t = todayFor(key);
      const n = newFor(key, audience);
      const singles: Partial<Record<SwitchName, FieldValues>> = {};
      for (const s of SWITCHES) singles[s] = previewFields(singleByKey.get(s)!, key, audience, oneSided);
      audiences[audience] = {
        today: oneSided ? { row: t.row } : t,
        new: oneSided ? { row: n.row } : n,
        legacy: previewFields(legacyByKey, key, audience, oneSided),
        singles,
      };
    }
    const stored = storedByKey.get(key);
    const legacy = legacyByKey.get(key);
    return {
      subsessionId,
      raceNumber: Number(raceText),
      driverId,
      driverName: today.names.get(driverId),
      audiences,
      storedRaw: stored ? pick(fieldsFromStored(stored), LEGACY_STALE_FIELDS) : { row: 0 },
      legacyRaw: legacy ? pick(fieldsFromScoreRow(legacy, 'raw'), LEGACY_STALE_FIELDS) : { row: 0 },
    };
  });

  // Pairs only for lines no single switch explains, each pair previewed once for the round.
  const neededPairs = [...new Set(inputs.flatMap((row) => pairsNeeded(row)))];
  if (neededPairs.length > 0) {
    const pairRows = await mapLimit(neededPairs, PREVIEW_CONCURRENCY, (k) =>
      fetchPreview(env, subsessionId, switchesWithOnly(pairSwitches(k))),
    );
    const pairByKey = new Map(neededPairs.map((k, i) => [k, byRowKey(pairRows[i])]));
    for (const row of inputs) {
      const key = rowKey(row.raceNumber, row.driverId);
      const oneSided = !today.values.has(key) || !newByKey.has(key);
      for (const audience of AUDIENCES) {
        const a = row.audiences[audience]!;
        a.pairs = {};
        for (const [k, rows] of pairByKey) a.pairs[k] = previewFields(rows, key, audience, oneSided);
      }
    }
  }

  return {
    subsessionId,
    posted: today.posted,
    lines: inputs.flatMap((row) => attributeRow(row)),
    previewCalls: configs.length + neededPairs.length,
  };
}

/** Every round with stored rows in race_score_results, ascending. */
export async function listScoredRounds(env: SupabaseEnv): Promise<number[]> {
  const rows = await restGetAll<{ subsession_id: number }>(
    env,
    'race_score_results?select=subsession_id&race_number=eq.1&order=subsession_id.asc',
  );
  return [...new Set(rows.map((r) => r.subsession_id))];
}

/** Open scoring_issues rows: rounds the new scoring could not score, listed as skipped in the report. */
export async function listScoringIssues(env: SupabaseEnv): Promise<{ subsessionId: number; reason: string }[]> {
  const rows = await restGet<{ subsession_id: number; message: string }[]>(
    env,
    'scoring_issues?select=subsession_id,message&order=subsession_id.asc',
  );
  return rows.map((r) => ({ subsessionId: r.subsession_id, reason: `scoring_issues: ${r.message}` }));
}
