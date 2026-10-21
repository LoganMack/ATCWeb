/**
 * APPEALS: a penalty can be marked `is_appealed`, with `appeal_result` (a
 * free-text ruling) and appeal_time_penalty_seconds/appeal_points_penalty/
 * appeal_penalty_points holding the corrected values. Every place this file
 * reads a penalty's time/points/PP goes through the effective* helpers
 * below, which swap in the appeal_* values once is_appealed is set — the
 * original fields stay as a record of what was first logged, but stop
 * being what's actually applied.
 */

// ---------------------------------------------------------------------------
// Appeals — effective-value helpers. Every consumer of a penalty's
// time/points/PP below goes through these instead of reading the raw
// columns directly, so an appeal transparently overrides what's applied.
// ---------------------------------------------------------------------------

export interface PenaltyLike {
  time_penalty_seconds: number | null;
  points_penalty: number;
  penalty_points: number;
  is_appealed: boolean;
  appeal_time_penalty_seconds: number | null;
  appeal_points_penalty: number;
  appeal_penalty_points: number;
}

/** The time penalty actually in effect — the appeal's corrected value once appealed, otherwise the original. */
export function effectiveTimePenaltySeconds(p: PenaltyLike): number | null {
  return p.is_appealed ? p.appeal_time_penalty_seconds : p.time_penalty_seconds;
}

/** The flat championship-points deduction actually in effect. */
export function effectivePointsPenalty(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_points_penalty : p.points_penalty;
}

/** The PP award actually in effect. */
export function effectivePenaltyPoints(p: PenaltyLike): number {
  return p.is_appealed ? p.appeal_penalty_points : p.penalty_points;
}

/**
 * "1PP" / "Warning" / "Penalty" / "Racing Incident" — the penalty-tag label
 * shown next to a driver's name wherever a table surfaces penalties.
 * QualifyingResultsTable.astro's qualifying rows import this directly (per
 * Logan: a penalty logged directly against qualifying, which scores onto
 * Race 1 — see scoringRaceNumber below — still needs to show up as a tag on
 * the QUALIFYING row too, not just wherever it ends up scoring).
 *
 * ResultsTable.astro deliberately does NOT import this — it keeps its own
 * private, independently-maintained `penaltyTagLabel` with identical logic.
 * Sharing this exact function with that one component (whether imported
 * directly, aliased, or wrapped) reproducibly broke `astro check`'s
 * TypeScript language service for that file only: it stopped typing the
 * file's `Astro.props` via `Props` entirely, cascading into unrelated
 * `implicitly has an 'any' type` errors on `rows`/`row.tags`/`penalties`.
 * Reproduced repeatedly with a cleared `.astro` type cache, and bisection
 * couldn't pin down a minimal trigger narrower than "this component
 * imports/wraps/redefines a function that plays this exact role" — so
 * rather than keep chasing it, ResultsTable.astro's copy is left alone as
 * plain unshared duplication. `npm run build` is unaffected either way; this
 * is purely an `astro check` quirk local to that one file. If touching the
 * tag logic in the future, both copies need the same edit — this one here
 * (QualifyingResultsTable.astro's import) and ResultsTable.astro's own
 * private `penaltyTagLabel`.
 *
 * Sums effective PP across every penalty in `rowPenalties`; falls back to
 * "Warning" only when nothing carries PP but at least one entry is a
 * warning. When a logged entry carries no real effect at all (no PP, no
 * warning, no time/points penalty — e.g. reviewed and cleared, or appealed
 * down to nothing), it reads as "Racing Incident" instead of "Penalty" per
 * Logan.
 *
 * The PP case reads just "XPP" (not "Penalty (XPP)"), and the warning case
 * reads just "Warning" (not "Penalty (Warning)") — both per Logan, so the
 * badge's text format matches regardless of which of the two applies. See
 * isRealPenaltyTag below for why the badge styling no longer keys off a
 * "Penalty" text prefix now that neither branch says that word anymore.
 *
 * Note this is a DIFFERENT "Racing Incident" than the literal one on the
 * Incident Report page (a penalty entry with no driver_id at all — see
 * 0020_penalty_racing_incident.sql). That kind can never reach this
 * function in the first place: `rowPenalties` is always pre-filtered to
 * entries already matched to one specific driver's id, and a driverless
 * entry can't match anyone's id.
 */
export function sharedPenaltyTagLabel(rowPenalties: (PenaltyLike & { is_warning: boolean })[]): string {
  if (rowPenalties.length === 0) return '';
  const totalPP = rowPenalties.reduce((sum, p) => sum + effectivePenaltyPoints(p), 0);
  if (totalPP > 0) return `${totalPP}PP`;
  if (rowPenalties.some((p) => p.is_warning)) return 'Warning';
  const hasTimeOrPointsEffect = rowPenalties.some(
    (p) => effectiveTimePenaltySeconds(p) !== 0 || effectivePointsPenalty(p) !== 0,
  );
  return hasTimeOrPointsEffect ? 'Penalty' : 'Racing Incident';
}

/** Whether a sharedPenaltyTagLabel() result (or ResultsTable.astro's own identical private penaltyTagLabel's result) should render with the "real penalty" gold badge styling (PP/Warning/Penalty) vs. the muted "logged but no effect" styling — true for everything except the empty string (no tag at all) and a bare "Racing Incident" with no logged effect. */
export function isRealPenaltyTag(tagLabel: string): boolean {
  return tagLabel !== '' && tagLabel !== 'Racing Incident';
}
