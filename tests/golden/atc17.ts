/**
 * Loads the ATC17 golden capture (tests/fixtures/golden/atc17/) and computes its standings through
 * the pure path, exactly as getSeasonOverallContext + computeSeasonStandings /
 * computeOverallSeasonStandings do on the live page (src/pages/standings/fragment.astro).
 * Shared by the golden test and the season-totals parity test.
 *
 * The scores are race_score_results_public rows (view-rows.json, adapted by toScoreRow); the
 * drivers, raw results, lap stats, penalties and rounds are the original capture (inputs.json).
 */
import { buildOverallSeasonStandings, buildSeasonStandings } from '../../src/lib/results/standings';
import { buildSeasonOverallContext, type SeasonOverallContext } from '../../src/lib/results/seasonContext';
import {
  toScoreRow,
  type CuratedRaceResultRow,
  type DriverBasic,
  type PublicScoreRow,
  type RawLapStatsRow,
  type RoundSummary,
  type ScoreRow,
} from '../../src/lib/results/rows';
import type { DriverSeasonStanding } from '../../src/lib/results/standingsCore';
import type { ScoringRuleset, Season } from '../../src/lib/db/seasons';
import { toPenalty, type PenaltyRow } from '../../src/lib/db/penalties';
import type { Lookup } from '../../src/lib/db/lookups';

// Bundled by Vite's glob import, so the tests need no Node file-system access.
const FILES = import.meta.glob('../fixtures/golden/atc17/*.json', { eager: true, import: 'default' });

function file<T>(name: string): T {
  const data = FILES[`../fixtures/golden/atc17/${name}`];
  if (data === undefined) throw new Error(`tests/fixtures/golden/atc17/${name} is missing`);
  return data as T;
}

/** The season columns the capture keeps; the rest of `Season` is never read by standings. */
type CapturedSeason = Pick<
  Season,
  'id' | 'number' | 'name' | 'is_current' | 'extra_drop_weeks' | 'scoring_ruleset_id'
>;

export interface GoldenInputs {
  season: CapturedSeason;
  rulesets: ScoringRuleset[];
  classes: Lookup[];
  drivers: DriverBasic[];
  excludedRoundIds: number[];
  /** The legacy race_scores_public rows of the original capture (the view was dropped at the scoring contract step). tests/lib/penaltyDisplay.test.ts and scripts/compute-timing.ts build results-page rows from them for applyPenaltyDisplay. */
  scoresByClass: Record<string, LegacyClassScore[]>;
  overallScores: LegacyOverallScore[];
  seasonRounds: RoundSummary[];
  rawResults: CuratedRaceResultRow[];
  lapStats: RawLapStatsRow[];
  penalties: PenaltyRow[];
}

/** A legacy per-class row (race_scores_public) as captured in inputs.json. */
export interface LegacyClassScore {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  team_id: string | null;
  total_points: number;
  class_points: number;
  finesse_bonus: number;
  points_deduction: number;
  pole_bonus: number;
  aggression_bonus: number;
  lap_led_bonus: number;
  fewest_incidents_bonus: number;
  fastest_lap_bonus: number;
  sprint_sweep_bonus: number;
  classified: boolean;
  dsq: boolean;
}

/** A legacy cross-class row (race_scores_public) as captured in inputs.json. */
export interface LegacyOverallScore {
  subsession_id: number;
  race_number: number;
  driver_id: string;
  class_id: number;
  team_id: string | null;
  finish_points: number;
  finesse_bonus: number;
  pole_bonus: number;
  points_deduction: number;
  aggression_bonus: number;
  dsq: boolean;
  classified: boolean;
  scored_position: number | null;
}

export interface GoldenRow {
  position: number;
  driverId: string;
  total: number;
}

export interface GoldenView {
  url: string;
  classId: number | null;
  rows: GoldenRow[];
}

export interface GoldenExpected {
  views: Record<string, GoldenView>;
}

/** view-rows.json: one array per row, in the order of `columns` (PublicScoreRow without season_id). */
interface CapturedViewRows {
  columns: (keyof PublicScoreRow)[];
  rows: unknown[][];
}

export const inputs = file<GoldenInputs>('inputs.json');
export const expected = file<GoldenExpected>('expected.json');

/** The adapter under test: a captured view row, as race_score_results_public returns it, to a ScoreRow. */
export function scoreRowsFrom(capture: CapturedViewRows, seasonId: string): ScoreRow[] {
  return capture.rows.map((values) => {
    // The capture predates the view's raw_ columns (migration 20261023120000); standings never read them.
    const row: Record<string, unknown> = {
      season_id: seasonId,
      raw_class_position: null,
      raw_overall_total: null,
      raw_class_total: null,
    };
    capture.columns.forEach((column, i) => (row[column] = values[i]));
    return toScoreRow(row as unknown as PublicScoreRow);
  });
}

/** Every class's rows for ATC17, as the view showed them to a signed-out reader (every round was posted). */
export const scores: ScoreRow[] = scoreRowsFrom(file<CapturedViewRows>('view-rows.json'), inputs.season.id);

export const season: Season = {
  ...inputs.season,
  logo_url: null,
  logo_url_light: null,
  start_date: null,
  end_date: null,
  gamma_enabled: false,
  delta_enabled: false,
  delta_team_enabled: false,
};

export const exhibitionIds = new Set(inputs.excludedRoundIds);

export function buildContext(): SeasonOverallContext {
  return buildSeasonOverallContext(
    exhibitionIds,
    inputs.drivers,
    scores,
    inputs.rawResults,
    inputs.penalties.map(toPenalty),
    inputs.seasonRounds,
    inputs.lapStats,
  );
}

/** The standings of one captured view: `classId` null is the overall view. */
export function standingsFor(
  classId: number | null,
  overallContext: SeasonOverallContext,
): DriverSeasonStanding[] {
  if (classId === null) {
    return buildOverallSeasonStandings({
      season,
      drivers: inputs.drivers,
      exhibitionIds,
      rulesets: inputs.rulesets,
      overallContext,
    });
  }
  return buildSeasonStandings({
    season,
    classId,
    scoresRaw: scores.filter((s) => s.class_id === classId),
    drivers: inputs.drivers,
    exhibitionIds,
    classes: inputs.classes,
    rulesets: inputs.rulesets,
    overallContext,
  });
}

/**
 * The round pool a view's standings are computed over: the subsession ids in its scores once
 * excluded rounds are removed (the `allSubsessionIds` each builder passes to finalizeStandings).
 */
export function poolFor(classId: number | null, overallContext: SeasonOverallContext): Set<number> {
  const pool = classId === null ? overallContext.overallScores : scores.filter((s) => s.class_id === classId);
  return new Set(pool.map((s) => s.subsession_id).filter((id) => !exhibitionIds.has(id)));
}

/**
 * view -> driver -> the ATC17 total since the switch to race_score_results_public, where it differs
 * from the live page in expected.json. Positions did not move. Each cause is one the owner accepted
 * (construction/scoring-ownership/comparison/decisions.json).
 */
export const DECIDED: Record<string, Record<string, number>> = {
  // cross-class-ripple (accept-new): Gamma finish points are priced from the post-penalty overall
  // order, so a Gamma driver moved up by another class's time penalty gains the points.
  Gamma: {
    'b8cb515b-f45e-4ceb-9390-473adb657a93': 1635,
    '590dd4a5-b0ed-41de-aca0-e52858e8309e': 1238,
    'cab9e197-fb3d-4653-b3bd-3545d8ab4a9e': 1180,
    '008e724f-d83a-4547-8eb7-a168f1a202a8': 1147,
    '65c38ce9-a7bd-4518-9017-7fc3cadfd037': 1050,
    '298c3c46-5a9e-44bf-9a02-45ac6a29c925': 869,
    '86874671-2fc1-47bf-a997-2ca76aed0ef0': 712,
    '57819a84-5b5e-4cc3-b912-4e7553c6dafd': 703,
  },
  // cross-class-ripple (accept-new), as for Gamma.
  Delta: {
    'fdcd6a29-5e48-4594-b316-02894df03b6f': 1048,
    '82bfb0e8-7c6f-420f-bd9c-04f787addc85': 945,
    '9e0e823d-e2be-4714-9f63-b635540a566c': 751,
    '7c73a663-6d52-47f6-8eb0-924ba1fde1ba': 639,
    '8811f320-0437-40f3-9d12-baa71686d55e': 618,
    'fe5a00cf-453e-4c59-942b-60c4a0126f15': 436,
    '2a2d04e6-f010-4379-8b84-ecbf495b44d4': 199,
    '8de7b229-3370-4c22-85d5-87300485c9af': 189,
    '15e6fc5d-7427-49b6-a009-3c4c16742562': 46,
  },
};

/** The live page's row with any decided total applied. */
export function wanted(view: string, row: GoldenRow): GoldenRow {
  const total = DECIDED[view]?.[row.driverId];
  return total === undefined ? row : { ...row, total };
}
