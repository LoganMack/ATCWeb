/**
 * Loads the ATC17 golden capture (tests/fixtures/golden/atc17/) and computes its standings through
 * the pure path, exactly as getSeasonOverallContext + computeSeasonStandings /
 * computeOverallSeasonStandings do on the live page (src/pages/standings/fragment.astro).
 * Shared by the golden test and the season-totals parity test.
 */
import { buildOverallSeasonStandings, buildSeasonStandings } from '../../src/lib/results/standings';
import { buildSeasonOverallContext, type SeasonOverallContext } from '../../src/lib/results/seasonContext';
import type {
  CuratedRaceResultRow,
  DriverBasic,
  RaceScoreOverallRow,
  RaceScoreRow,
  RawLapStatsRow,
  RoundSummary,
} from '../../src/lib/results/rows';
import type { DriverSeasonStanding } from '../../src/lib/results/standingsCore';
import { resolveSeasonRuleset, type ScoringRuleset, type Season } from '../../src/lib/db/seasons';
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
  scoresByClass: Record<string, RaceScoreRow[]>;
  overallScores: RaceScoreOverallRow[];
  seasonRounds: RoundSummary[];
  rawResults: CuratedRaceResultRow[];
  lapStats: RawLapStatsRow[];
  penalties: PenaltyRow[];
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

export const inputs = file<GoldenInputs>('inputs.json');
export const expected = file<GoldenExpected>('expected.json');

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
  const rules = resolveSeasonRuleset(season, inputs.rulesets)?.rules ?? null;
  return buildSeasonOverallContext(
    exhibitionIds,
    inputs.drivers,
    inputs.overallScores,
    inputs.rawResults,
    inputs.penalties.map(toPenalty),
    inputs.seasonRounds,
    inputs.lapStats,
    rules,
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
    scoresRaw: inputs.scoresByClass[String(classId)] ?? [],
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
  const scores: { subsession_id: number }[] =
    classId === null ? overallContext.overallScores : (inputs.scoresByClass[String(classId)] ?? []);
  return new Set(scores.map((s) => s.subsession_id).filter((id) => !exhibitionIds.has(id)));
}
