import { resolveSeasonRuleset, type ScoringRuleset, type Season } from '../db/seasons';
import type { Penalty } from '../db/penalties';
import { displayDriverName } from '../db/circuits';
import {
  effectivePenaltyPoints,
  effectiveTimePenaltySeconds,
  effectivePointsPenalty,
} from '../penalties/effective';
import type { DriverBasic, RoundSummary } from './rows';
import { compareStandings, dropsFor, dropWorstRounds, type StandingKeys } from '../seasonTotals';

// ---------------------------------------------------------------------------
// Season standings
// ---------------------------------------------------------------------------

export interface DriverSeasonStanding {
  driver: DriverBasic;
  position: number;
  totalPoints: number;
  starts: number;
  appearances: number;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  poles: number;
  /** Season total laps led (curated_race_results.laps_led, summed across every race counted for this view) — shown in the standings driver detail panel and used as a tiebreaker (see finalizeStandings). */
  lapsLed: number;
  /** Season total laps completed (curated_race_results.laps_complete, summed across every race counted for this view) — same uses as lapsLed. */
  laps: number;
  /** Only set by `computeOverallSeasonStandings` — which class this driver actually raced, so the overall (every class combined) table can still show it. */
  classId?: number;
  /** Standings page's "Matrix" view — one entry per round this driver actually attended (never a zero-filled entry for a round they skipped — see StandingsRoundCell). Keyed by subsession_id; pair with getSeasonStandingsRoundColumns for the full ordered list of column headers, including rounds this driver missed entirely. */
  roundCells: Map<number, StandingsRoundCell>;
  /** Per-round breakdown of this row's wins/podiums/top5s/top10s/poles/starts/laps-led/laps — feeds the standings page's "Standings by Round" slider, which recomputes every column as of an earlier round. Keyed by subsession_id; a round this driver skipped has no entry. Sums to the season totals above. */
  roundStats: Map<number, StandingsRoundStat>;
}

/** One round's worth of the counting stats DriverSeasonStanding totals — see DriverSeasonStanding.roundStats. */
export interface StandingsRoundStat {
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  /** 0 or 1 — poles are counted per round (distinct subsession), not per race. */
  poles: number;
  starts: number;
  lapsLed: number;
  laps: number;
}

/** One column of the standings page's "Matrix" view — one per round the season actually had (see computeSeasonStandingsRoundColumns), chronologically ordered by start_time. The column header itself is just `roundNumber` (Logan: keep the columns narrow) — `trackName`/`format` are there for the header's hover tooltip. */
export interface SeasonStandingsRoundColumn {
  subsessionId: number;
  trackName: string;
  startTime: string;
  /** This round's site-wide "Round N" display number — same numbering `computeDisplayRoundNumbers` produces everywhere else on the site (the results page's own "Round N" heading, etc.), passed in rather than recomputed here since it needs the site's full exhibition/test-round context, not just this one season. Null in the (normally unreachable) case that context didn't have an entry for this round — a column's own subsessionId only ever comes from an already exhibition/test-filtered pool, so this is just defensive. */
  roundNumber: number | null;
  format: 'endurance' | 'sprint' | null;
}

/** One cell of the standings page's "Matrix" view — a single driver's or team's result for a single round column (DriverSeasonStanding.roundCells / TeamSeasonStanding.roundCells). A round with no entry in that map means the driver/team didn't attend it at all — never rendered as a zero. */
export interface StandingsRoundCell {
  points: number;
  /** True when this round's points did NOT count toward the season total — one of the driver's worst-N dropped rounds (see finalizeStandings/BASELINE_DROP_WEEKS). Teams never drop rounds at all (see computeTeamSeasonStandings' own doc comment on why), so this is always false on a TeamSeasonStanding's cells. */
  dropped: boolean;
  /** One short human-readable line per penalty logged this round against this driver (or, on a team's cell, against any driver who scored for that team this season this season) — the Matrix cell's hover summary. Empty means no penalty; doesn't imply an entry here actually moved points (a Racing-Incident-only or quali/practice-only penalty still gets a line). See summarizePenalty. */
  penalties: string[];
}

/** One penalty, formatted for the Matrix cell hover tooltip — appeal-aware (mirrors whatever's actually in effect, same as everywhere else penalties are applied/displayed — see src/lib/penalties.ts's effective* helpers), e.g. "Contact — avoidable (12s, -3 pts, 2 PP)" or "Off track (warning)" for a bare warning with no other consequence. Exported so the Event Briefing page's "past incidents at this layout" list (src/pages/briefing/[eventId].astro) can reuse the exact same one-line formatting instead of re-deriving it. */
export function summarizePenalty(p: Penalty): string {
  const consequences: string[] = [];
  const time = effectiveTimePenaltySeconds(p);
  if (time) consequences.push(`${time}s`);
  const points = effectivePointsPenalty(p);
  if (points) consequences.push(`-${points} pts`);
  const pp = effectivePenaltyPoints(p);
  if (pp) consequences.push(`${pp} PP`);
  if (p.is_warning) consequences.push('warning');
  const label = p.description?.trim() || 'Racing incident';
  return consequences.length > 0 ? `${label} (${consequences.join(', ')})` : label;
}

/**
 * Just the "resolution" half of summarizePenalty()'s formatting — e.g. "12s,
 * -3 pts, 2 PP" or "Warning" — with no description text folded in and no
 * wrapping parens. Null when this penalty carries no consequence at all (a
 * bare log entry — rare, but possible for a purely informational note).
 * Used by the Event Briefing page's "past incidents" list
 * (src/pages/briefing/[eventId].astro), which shows this on its own line
 * beneath the (collapsible) description rather than folded into one string
 * the way the standings Matrix's compact hover tooltip needs it.
 */
export function describePenaltyResolution(p: Penalty): string | null {
  const consequences: string[] = [];
  const time = effectiveTimePenaltySeconds(p);
  if (time) consequences.push(`${time}s`);
  const points = effectivePointsPenalty(p);
  if (points) consequences.push(`-${points} pts`);
  const pp = effectivePenaltyPoints(p);
  if (pp) consequences.push(`${pp} PP`);
  if (p.is_warning) consequences.push('Warning');
  return consequences.length > 0 ? consequences.join(', ') : null;
}

/**
 * driver_id -> subsession_id -> every penalty logged against that driver in
 * that round, this season — the source for each Matrix cell's `penalties`
 * summary. Built once from the season's full penalty list
 * (SeasonOverallContext.penalties, already fetched by every standings
 * caller) and reused by every view that needs it, rather than each
 * re-scanning the penalty list itself.
 */
export function buildPenaltiesByDriverAndRound(penalties: Penalty[]): Map<string, Map<number, Penalty[]>> {
  const map = new Map<string, Map<number, Penalty[]>>();
  for (const p of penalties) {
    if (!p.driver_id) continue; // Racing Incident — no driver attached, nothing to flag
    let bySubsession = map.get(p.driver_id);
    if (!bySubsession) {
      bySubsession = new Map();
      map.set(p.driver_id, bySubsession);
    }
    const list = bySubsession.get(p.subsession_id);
    if (list) list.push(p);
    else bySubsession.set(p.subsession_id, [p]);
  }
  return map;
}

/**
 * The standings Matrix view's shared column list — every round a season
 * actually had (already exhibition-filtered), sorted chronologically. Same
 * `seasonRounds` a SeasonOverallContext already carries, just narrowed to
 * the rounds a given view's `allSubsessionIds` pool actually contains (a
 * class-scoped view may not have raced every round the season had overall,
 * e.g. a class that skipped an exhibition-adjacent round). `displayRoundNumbers`
 * is `computeDisplayRoundNumbers`'s own output — the caller's to compute
 * since it needs the site's full exhibition/test-round sets, not just this
 * function's narrower `allSubsessionIds` pool.
 */
export function computeSeasonStandingsRoundColumns(
  seasonRounds: RoundSummary[],
  allSubsessionIds: Set<number>,
  displayRoundNumbers: Map<number, number | null>,
): SeasonStandingsRoundColumn[] {
  return seasonRounds
    .filter((r) => allSubsessionIds.has(r.subsession_id))
    .map((r) => ({
      subsessionId: r.subsession_id,
      trackName: r.track_name,
      startTime: r.start_time,
      roundNumber: displayRoundNumbers.get(r.subsession_id) ?? null,
      format: r.format,
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.subsessionId - b.subsessionId);
}

/** Fallback drop count when a season's ruleset doesn't specify `rules.drops.base` (or no ruleset resolves at all). Every ruleset on file today sets its own value — see `rulesetBaseDropWeeks`. */
export const BASELINE_DROP_WEEKS = 2;

/**
 * A ruleset's base number of drop weeks (`rules.drops.base`), falling back to
 * BASELINE_DROP_WEEKS when the ruleset is missing or the field isn't a
 * non-negative whole number. The season's own `extra_drop_weeks` is added on
 * top by `seasonDropWeeks`.
 */
export function rulesetBaseDropWeeks(ruleset: ScoringRuleset | null | undefined): number {
  const base = (ruleset?.rules as { drops?: { base?: unknown } } | null | undefined)?.drops?.base;
  return typeof base === 'number' && Number.isInteger(base) && base >= 0 ? base : BASELINE_DROP_WEEKS;
}

/** Total drop weeks a season's driver standings get: its ruleset's base plus the season's `extra_drop_weeks`. */
export function seasonDropWeeks(
  season: Pick<Season, 'scoring_ruleset_id' | 'extra_drop_weeks'>,
  rulesets: ScoringRuleset[],
): number {
  return rulesetBaseDropWeeks(resolveSeasonRuleset(season, rulesets)) + (season.extra_drop_weeks ?? 0);
}
/** Drop weeks don't kick in until the championship has actually run this many rounds — per Logan. Below this, `finalizeStandings` forces the drop count to 0 regardless of `BASELINE_DROP_WEEKS`/`extra_drop_weeks`, so every round scored so far still counts toward the total (no early-season "your worst round doesn't count" swings while the sample size is tiny). */
export const MIN_ROUNDS_FOR_DROPS = 5;

/**
 * The chronologically last non-excluded (exhibition/test) round of a
 * season, if it's raced yet — what "the final round" means for
 * ScoringRuleset.can_drop_final_round (see finalizeStandings below). Ties
 * on start_time (shouldn't normally happen) fall back to the higher
 * round_number; otherwise picking either would be equally arbitrary.
 * Returns null for a season with no eligible rounds at all yet.
 */
export function findFinalRoundSubsessionId(
  seasonRounds: RoundSummary[],
  excludedRoundIds: Set<number>,
): number | null {
  const eligible = seasonRounds.filter((r) => !excludedRoundIds.has(r.subsession_id));
  if (eligible.length === 0) return null;
  let final = eligible[0];
  for (const r of eligible) {
    if (
      r.start_time > final.start_time ||
      (r.start_time === final.start_time && (r.round_number ?? -1) > (final.round_number ?? -1))
    ) {
      final = r;
    }
  }
  return final.subsession_id;
}

export interface StandingsAccum {
  starts: number;
  subsessionIds: Set<number>;
  poleSubsessionIds: Set<number>;
  wins: number;
  podiums: number;
  top5s: number;
  top10s: number;
  lapsLed: number;
  laps: number;
  roundPoints: Map<number, number>;
  roundStats: Map<number, StandingsRoundStat>;
  classId?: number;
}

export function newStandingsAccum(): StandingsAccum {
  return {
    starts: 0,
    subsessionIds: new Set(),
    poleSubsessionIds: new Set(),
    wins: 0,
    podiums: 0,
    top5s: 0,
    top10s: 0,
    lapsLed: 0,
    laps: 0,
    roundPoints: new Map(),
    roundStats: new Map(),
  };
}

export function roundStatFor(a: StandingsAccum, subsessionId: number): StandingsRoundStat {
  let r = a.roundStats.get(subsessionId);
  if (!r) {
    r = { wins: 0, podiums: 0, top5s: 0, top10s: 0, poles: 0, starts: 0, lapsLed: 0, laps: 0 };
    a.roundStats.set(subsessionId, r);
  }
  return r;
}

/**
 * Shared by `computeSeasonStandings` and `computeOverallSeasonStandings` —
 * turns each one's per-driver accumulators into sorted, positioned
 * standings (worst-rounds-dropped point totals, then wins/podiums as
 * tiebreakers).
 *
 * `allSubsessionIds` is every round this season had (for the class being
 * computed, or every class for the overall view). The drop-week pool is
 * padded to that full set, not just the rounds a driver has a
 * `roundPoints` entry for — a round they scored 0 in already has a real
 * zero entry from the caller's loop, but a round they didn't show up for
 * at all wouldn't get one without this padding, and would vanish from
 * their pool instead of being an available (and likely-dropped) week.
 * Without it, the baseline drop count ate into real scored rounds on top
 * of whatever a driver had already missed, instead of the no-show weeks
 * themselves absorbing the drop.
 *
 * Ties are broken column by column, per Logan: "wins, podiums, top 5s,
 * top 10s, poles, laps led, laps, and appearances. If they are still tied,
 * alphabetical order." Whatever stats `accum` was built with are already
 * the right variant for the view being computed — computeSeasonStandings'
 * wins/podiums/top5s/top10s are already class-relative (and Gamma/Delta's
 * `poles` is already that class's own Class Pole count) — so one
 * comparator serves every view without needing to know which one it's
 * sorting.
 *
 * `finalRoundSubsessionId`/`canDropFinalRound` implement
 * ScoringRuleset.can_drop_final_round: when false (the default), the
 * season's final round can never be one of the dropped worst rounds, even
 * if its points would otherwise qualify — it's forced into the counted
 * set, and the drop count comes entirely from the remaining rounds. Either
 * way the total number of rounds counted is unchanged (see the two
 * branches below) — only which round is guaranteed counted.
 *
 * `allSubsessionIds.size` doubles as "how many rounds has this championship
 * actually run" (see its own param doc above — it's already the
 * exhibition-filtered pool both callers pass), which is also what gates
 * MIN_ROUNDS_FOR_DROPS below: too early in a season, dropping a driver's
 * worst round would mean a single lucky/unlucky week swings the standings
 * disproportionately, so no rounds drop at all until the season's raced
 * enough of them for a "worst round" to be a meaningful outlier rather than
 * a third of the season.
 */
export function finalizeStandings(
  accum: Map<string, StandingsAccum>,
  driverById: Map<string, DriverBasic>,
  season: Season,
  allSubsessionIds: Set<number>,
  finalRoundSubsessionId: number | null = null,
  canDropFinalRound: boolean = true,
  /** The season's ruleset's `rules.drops.base` (see rulesetBaseDropWeeks) — season.extra_drop_weeks is added on top below. */
  baseDropWeeks: number = BASELINE_DROP_WEEKS,
  /** Standings Matrix view's penalty summaries (StandingsRoundCell.penalties) — see buildPenaltiesByDriverAndRound. Omitted entirely leaves every cell's penalties empty, harmless for any caller that doesn't need the Matrix view. */
  penaltiesByDriverAndRound?: Map<string, Map<number, Penalty[]>>,
): DriverSeasonStanding[] {
  const totalDrops = dropsFor(
    allSubsessionIds.size,
    baseDropWeeks + (season.extra_drop_weeks ?? 0),
    MIN_ROUNDS_FOR_DROPS,
  );
  // Only a constraint when the final round is in this pool (this class may
  // not have raced it) and the ruleset protects it.
  const protectedRound = !canDropFinalRound ? finalRoundSubsessionId : null;

  const standings: { row: Omit<DriverSeasonStanding, 'position'>; keys: StandingKeys }[] = [];
  for (const [driverId, a] of accum) {
    const driver = driverById.get(driverId);
    if (!driver) continue; // driver record deleted/missing — skip rather than crash the page

    // A round the driver skipped is in the pool as 0 (see the doc comment);
    // equal rounds drop the higher subsession id, which only decides which
    // cell is marked dropped, never the total.
    const pool = [...allSubsessionIds].map((id) => ({ order: id, points: a.roundPoints.get(id) ?? 0 }));
    const { total: totalPoints, dropped: droppedSubsessionIds } = dropWorstRounds(
      pool,
      totalDrops,
      protectedRound,
    );

    // Matrix view's per-round cells — only for rounds this driver actually
    // attended (a.roundPoints only ever has an entry for a round this
    // driver started at all, see newStandingsAccum's own doc comment); a
    // round they skipped entirely gets no cell rather than a misleading
    // dropped/0 one.
    const roundCells = new Map<number, StandingsRoundCell>();
    for (const [subsessionId, points] of a.roundPoints) {
      roundCells.set(subsessionId, {
        points,
        dropped: droppedSubsessionIds.has(subsessionId),
        penalties: (penaltiesByDriverAndRound?.get(driverId)?.get(subsessionId) ?? []).map(summarizePenalty),
      });
    }

    const row = {
      driver,
      totalPoints,
      starts: a.starts,
      appearances: a.subsessionIds.size,
      wins: a.wins,
      podiums: a.podiums,
      top5s: a.top5s,
      top10s: a.top10s,
      poles: a.poleSubsessionIds.size,
      lapsLed: a.lapsLed,
      laps: a.laps,
      classId: a.classId,
      roundCells,
      roundStats: a.roundStats,
    };
    standings.push({ row, keys: { ...row, name: displayDriverName(driver.name) } });
  }

  standings.sort((x, y) => compareStandings(x.keys, y.keys));
  return standings.map((s, i) => ({ ...s.row, position: i + 1 }));
}
